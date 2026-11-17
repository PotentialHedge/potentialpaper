import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  pageAncestors,
  pageMembers,
  pageMemberSources,
  pageParents,
  pageScopeNames,
  paperIdentifiers,
  papers,
} from '@/db/schema';
import { formatIdentifier, KINDS, type PageAddress, parentsOf, sourcesOf } from '@/lib/kinds';
import { canonicalPaperId } from '@/lib/paper-ids';
import { TOPIC_LABELS } from '@/lib/labeled-links';
import { parseReviewFile, parseReviewPath } from '@/lib/review-files';
import type { Consumer } from './consumers/types';
import { readPageLinks } from './page-links';
import { formerKeys, mustPage, type PageRow, survivorOf } from './pages/kinds';
import { readCommit, readFiles, readText, type Reader } from './pages/repo';
import type { Writer } from './pages/projections';
import { markPaperScopes, markScopes } from './scope-stats';

/**
 * Membership of the pages above the paper (`handoffs/pages.md`): which papers a venue, topic or org has, kept by
 * the `members` consumer in `page_members`, and the roll-up closure in `page_ancestors`. Every list, count and
 * statistic of a scope reads these.
 *
 * Both sides of a membership are pages that change on their own, so each side's half is kept apart and joined:
 *
 * - a **paper's** event writes what it says it belongs to, by public name (`page_member_sources`): each
 *   submission's venue, as `<source>:<venue id>` from `reviews/<source>/<submission>/submission.json`, and each
 *   topic it links to with `in-topic` or `introduces-topic`, from its `links.jsonl`;
 * - a **scope's** event writes the names it answers to (`page_scope_names`: its identifier and its kind file's
 *   `sources`) and its parents (`page_parents`).
 *
 * Then the paper's or the scope's rows of `page_members` are joined again from those, so the result is the same
 * whichever page changed first, and a rebuild gives the same rows.
 *
 * **Orgs** (`handoffs/pages.md` Phase 4): a paper is from an org through the confirmed author claims of verified
 * members who show their institution (`accounts.show_institution`), and through the addresses printed on its page 1
 * (`pdf_documents.emails`). Each is a source `domain:<domain>` with `via` `affiliation`, one per domain from the
 * address's up to its last two labels (`inf.ethz.ch`, `ethz.ch`), weight 1 for a claim and 0.5 for a printed
 * address; an org page answers to `domain:<d>` for each of its `org.json` `domains`. These come from tables, not
 * the paper's repo, so besides the paper's own events they are brought up to date by the worker's `org-members` task
 * (`syncDueAffiliations`), from a queue (`org_members_due`) that triggers on `author_claims`, `affiliations`,
 * `accounts` and `pdf_documents` fill (migration `0038`). Claims and printed addresses share one `via`, so nothing
 * public says which of the two put a paper on an org's page.
 */

interface MemberSource {
  via: string;
  source: string;
}

/** How an org's papers belong (`page_members.via`), whether through a member's claim or a printed address. */
export const AFFILIATION_VIA = 'affiliation';
/** The weight of a paper from an org through an address printed on page 1 alone: likely, not certain. */
export const PRINTED_ADDRESS_WEIGHT = 0.5;

/** A list of page ids for `in (…)`. */
function idList(ids: readonly string[]) {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

/**
 * The affiliation sources of the papers `paperIds` selects (a subquery of page ids, or every paper when `null`):
 * each domain of a confirmed author's confirmed address, where the author is a verified account (not a bot) that
 * shows its institution, and each domain of an address printed on page 1 of the paper's current PDF.
 */
function affiliationSources(paperIds: SQL | null) {
  const claims = paperIds ? sql`and ac.paper_id in (${paperIds})` : sql``;
  const printed = paperIds ? sql`where c.page_id in (${paperIds})` : sql``;
  return sql`
    select x.paper_id, ${AFFILIATION_VIA} as via, 'domain:' || x.domain as source, max(x.weight) as weight
      from (
        select ac.paper_id, s.domain, 1::float8 as weight
          from author_claims ac
          join accounts a on a.id = ac.account_id and a.show_institution and a.verified_at is not null and not a.is_bot
          join affiliations f on f.account_id = a.id and f.verified_at is not null
          cross join lateral domain_suffixes(split_part(f.email, '@', 2)) s(domain)
         where ac.status = 'confirmed' ${claims}
        union all
        select c.page_id, s.domain, ${PRINTED_ADDRESS_WEIGHT}::float8
          from page_current c
          join pdf_documents d on d.sha256 = c.pdf ->> 'sha256'
          cross join lateral unnest(d.emails) e(email)
          cross join lateral domain_suffixes(split_part(e.email, '@', 2)) s(domain)
          ${printed}
      ) x
      join pages p on p.id = x.paper_id and p.kind = 'paper'
     group by x.paper_id, x.domain
  `;
}

/** Writes the affiliation sources of the papers `paperIds` selects (all of them when `null`), replacing theirs. */
async function writeAffiliationSources(tx: Writer, paperIds: SQL | null): Promise<void> {
  await tx.execute(
    paperIds
      ? sql`delete from page_member_sources where via = ${AFFILIATION_VIA} and paper_id in (${paperIds})`
      : sql`delete from page_member_sources where via = ${AFFILIATION_VIA}`,
  );
  await tx.execute(sql`
    insert into page_member_sources (paper_id, via, source, weight)
    ${affiliationSources(paperIds)}
    on conflict (paper_id, via, source) do update set weight = excluded.weight
  `);
}

/** What a paper at this commit says it belongs to. */
async function paperSources(db: Reader, page: PageRow, files: ReadonlyMap<string, string>): Promise<MemberSource[]> {
  const out = new Map<string, MemberSource>();
  for (const [path, blob] of files) {
    const review = parseReviewPath(path);
    if (review?.kind !== 'submission') continue;
    const parsed = parseReviewFile('submission', (await readText(db, page.id, blob)) ?? '');
    if (!('file' in parsed)) continue;
    const source = `${review.source}:${parsed.file.venue.id}`;
    out.set(`submission ${source}`, { via: 'submission', source });
  }
  for (const { link } of await readPageLinks(db, page, files)) {
    if (!TOPIC_LABELS.includes(link.label)) continue;
    out.set(`${link.label} ${link.target}`, { via: link.label, source: link.target });
  }
  return [...out.values()];
}

/** Joins the rows of `page_members` of the papers `paperIds` selects again from their sources and the scopes' names. */
async function joinPapers(tx: Writer, paperIds: SQL): Promise<void> {
  await tx.execute(sql`delete from page_members where paper_id in (${paperIds})`);
  await tx.execute(sql`
    insert into page_members (scope_page_id, paper_id, via, weight)
    select n.page_id, s.paper_id, s.via, max(s.weight)
      from page_member_sources s
      join page_scope_names n on n.name = s.source
     where s.paper_id in (${paperIds})
     group by n.page_id, s.paper_id, s.via
    on conflict do nothing
  `);
}

/** Joins the scope's rows of `page_members` again from its names and the papers' sources. */
async function joinScope(tx: Writer, scopeId: string): Promise<void> {
  await tx.delete(pageMembers).where(eq(pageMembers.scopePageId, scopeId));
  await tx.execute(sql`
    insert into page_members (scope_page_id, paper_id, via, weight)
    select n.page_id, s.paper_id, s.via, max(s.weight)
      from page_scope_names n
      join page_member_sources s on s.source = n.name
     where n.page_id = ${scopeId}
     group by n.page_id, s.paper_id, s.via
    on conflict do nothing
  `);
}

/** Deepest roll-up followed; a cycle in `broader` or `parents` stops at the page it came back to. */
const MAX_DEPTH = 16;

/**
 * `page_ancestors` again, whole: the closure of `page_parents` over the pages they name. Scopes are few (venues,
 * orgs, topics: thousands), and a scope's parents change rarely, so this is cheap enough to do on each scope's
 * event; the seam, if it grows, is recomputing only the changed page's descendants.
 */
async function closeAncestors(tx: Writer): Promise<void> {
  await tx.delete(pageAncestors);
  await tx.execute(sql`
    insert into page_ancestors (page_id, ancestor_id, depth)
    with recursive edges as (
      select distinct p.page_id, n.page_id as parent_id
        from page_parents p
        join page_scope_names n on n.name = p.parent
       where n.page_id <> p.page_id
    ), closure (page_id, ancestor_id, depth, seen) as (
      select page_id, parent_id, 1, array[page_id, parent_id] from edges
      union all
      select c.page_id, e.parent_id, c.depth + 1, c.seen || e.parent_id
        from closure c
        join edges e on e.page_id = c.ancestor_id
       where not e.parent_id = any(c.seen) and c.depth < ${MAX_DEPTH}
    )
    select page_id, ancestor_id, min(depth) from closure group by page_id, ancestor_id
  `);
}

/** Brings one page's half of membership up to `head`. */
export async function indexMembers(database: Database, pageId: string, head: string): Promise<void> {
  const page = await mustPage(database, pageId);
  const commit = await readCommit(database, pageId, head);
  const files = await readFiles(database, pageId, commit.tree);

  if (page.kind === 'paper') {
    const sources = await paperSources(database, page, files);
    await database.transaction(async (tx) => {
      // The scopes it leaves and the scopes it joins: their statistics are due again (`scope-stats.ts`).
      await markPaperScopes(tx, pageId);
      await tx.delete(pageMemberSources).where(eq(pageMemberSources.paperId, pageId));
      if (sources.length > 0) {
        await tx.insert(pageMemberSources).values(sources.map((s) => ({ paperId: pageId, ...s })));
      }
      // Its PDF may have changed, and with it the addresses on page 1.
      await writeAffiliationSources(tx, sql`select ${pageId}::uuid`);
      await joinPapers(tx, sql`select ${pageId}::uuid`);
      await markPaperScopes(tx, pageId);
    });
    return;
  }
  if (!KINDS[page.kind].scope) return;

  // A topic merged into another is no scope of its own: the survivor answers to its names (`topic-pages.ts`).
  if ((await survivorOf(database, page)).id !== page.id) {
    await database.transaction(async (tx) => {
      await markScopes(tx, sql`select ${pageId}::uuid`);
      await tx.delete(pageScopeNames).where(eq(pageScopeNames.pageId, pageId));
      await tx.delete(pageParents).where(eq(pageParents.pageId, pageId));
      await tx.delete(pageMembers).where(eq(pageMembers.scopePageId, pageId));
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('page-ancestors', 0))`);
      await closeAncestors(tx);
    });
    return;
  }

  let kindFile: unknown = null;
  try {
    kindFile = JSON.parse((await readText(database, pageId, files.get(KINDS[page.kind].kindFile))) ?? 'null');
  } catch {
    // A kind file that doesn't parse names no sources and no parents.
  }
  const kind = page.kind;
  // Its old keys too (a renamed topic's, those of topics merged into it), so links that name them still count.
  const names = [
    ...[page.key, ...(await formerKeys(database, page))].map((key) => formatIdentifier({ kind, key })),
    ...sourcesOf(page.kind, kindFile),
  ] as string[];
  const parents = parentsOf(page.kind, page.key, kindFile);
  await database.transaction(async (tx) => {
    // The scope and those above it, before and after: membership and roll-up may both move.
    await markScopes(tx, sql`select ${pageId}::uuid`);
    await tx.delete(pageScopeNames).where(eq(pageScopeNames.pageId, pageId));
    await tx.insert(pageScopeNames).values([...new Set(names)].map((name) => ({ pageId, name })));
    await tx.delete(pageParents).where(eq(pageParents.pageId, pageId));
    if (parents.length > 0) await tx.insert(pageParents).values(parents.map((parent) => ({ pageId, parent })));
    await joinScope(tx, pageId);
    // One writer at a time rebuilds the closure: the consumer runs once per lease, but a rebuild may overlap.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('page-ancestors', 0))`);
    await closeAncestors(tx);
    await markScopes(tx, sql`select ${pageId}::uuid`);
  });
}

export const membersConsumer: Consumer = {
  name: 'members',
  async handle(pageId, head, { database }) {
    await indexMembers(database, pageId, head);
  },
  async reset({ database }) {
    await database.transaction(async (tx) => {
      await tx.execute(
        sql`truncate page_members, page_member_sources, page_scope_names, page_parents, page_ancestors, org_members_due`,
      );
      // A paper with claims but no repo has no events to replay; its affiliations are written here, and joined when
      // the org pages' events are.
      await writeAffiliationSources(tx, null);
    });
  },
};

/**
 * Brings the affiliation sources of the papers due (`org_members_due`) up to date, and their rows of `page_members`,
 * a batch at a time; the worker's `org-members` task. Returns how many papers it did.
 */
export async function syncDueAffiliations(options: { database?: Database; batch?: number } = {}): Promise<number> {
  const { database = getDb(), batch = 500 } = options;
  let done = 0;
  for (;;) {
    const ids = await database.transaction(async (tx) => {
      const { rows } = await tx.execute<{ paper_id: string }>(sql`
        delete from org_members_due
         where paper_id in (
           select paper_id from org_members_due order by marked_at, paper_id limit ${batch} for update skip locked
         )
        returning paper_id
      `);
      const ids = rows.map((row) => row.paper_id).sort();
      if (ids.length === 0) return ids;
      const papers = sql`select id from pages where kind = 'paper' and id in ${idList(ids)}`;
      await markScopes(tx, sql`select scope_page_id from page_members where paper_id in (${papers})`);
      await writeAffiliationSources(tx, papers);
      await joinPapers(tx, papers);
      await markScopes(tx, sql`select scope_page_id from page_members where paper_id in (${papers})`);
      return ids;
    });
    done += ids.length;
    if (ids.length < batch) return done;
  }
}

/** A scope's pages: itself and every page it is an ancestor of (its editions, narrower topics, labs). */
export function rolledUp(scopeId: string) {
  return or(
    eq(pageMembers.scopePageId, scopeId),
    inArray(
      pageMembers.scopePageId,
      sql`(select ${pageAncestors.pageId} from ${pageAncestors} where ${pageAncestors.ancestorId} = ${scopeId})`,
    ),
  );
}

export interface ScopeMember {
  paperId: string;
  /** How it belongs, by each way it does: `submission`, `in-topic`, … */
  via: string[];
}

/**
 * The papers of a scope, rolled up from the pages under it by default, a page of them at a time, most recently
 * added papers first.
 */
export async function scopeMembers(
  scopeId: string,
  options: { rollUp?: boolean; via?: string; limit?: number; offset?: number; database?: Database } = {},
): Promise<ScopeMember[]> {
  const { rollUp = true, via, limit = 50, offset = 0, database = getDb() } = options;
  const rows = await database
    .select({ paperId: pageMembers.paperId, via: sql<string[]>`array_agg(distinct ${pageMembers.via})` })
    .from(pageMembers)
    .where(
      and(
        rollUp ? rolledUp(scopeId) : eq(pageMembers.scopePageId, scopeId),
        via ? eq(pageMembers.via, via) : undefined,
      ),
    )
    .groupBy(pageMembers.paperId)
    .orderBy(pageMembers.paperId)
    .limit(limit)
    .offset(offset);
  return rows;
}

/** How many papers a scope has, rolled up by default. */
export async function scopeMemberCount(
  scopeId: string,
  options: { rollUp?: boolean; database?: Database } = {},
): Promise<number> {
  const { rollUp = true, database = getDb() } = options;
  const [row] = await database
    .select({ n: sql<number>`count(distinct ${pageMembers.paperId})::int` })
    .from(pageMembers)
    .where(rollUp ? rolledUp(scopeId) : eq(pageMembers.scopePageId, scopeId));
  return row?.n ?? 0;
}

/** The scopes a paper is in, directly (not their ancestors). */
export async function scopesOf(
  paperId: string,
  database: Database = getDb(),
): Promise<{ pageId: string; via: string }[]> {
  return database
    .select({ pageId: pageMembers.scopePageId, via: pageMembers.via })
    .from(pageMembers)
    .where(eq(pageMembers.paperId, paperId));
}

/** A paper of a scope, as a list shows it. */
export interface ScopePaper {
  paperId: string;
  title: string;
  year: number | null;
  address: PageAddress | null;
  via: string[];
}

/** A scope's papers with their titles and addresses, newest first, rolled up from the pages under it. */
export async function scopePapers(
  scopeId: string,
  options: { limit?: number; database?: Database } = {},
): Promise<ScopePaper[]> {
  const { limit = 100, database = getDb() } = options;
  const rows = await database
    .select({
      paperId: pageMembers.paperId,
      title: papers.title,
      year: papers.year,
      via: sql<string[]>`array_agg(distinct ${pageMembers.via})`,
    })
    .from(pageMembers)
    .innerJoin(papers, eq(papers.id, pageMembers.paperId))
    .where(rolledUp(scopeId))
    .groupBy(pageMembers.paperId, papers.title, papers.year, papers.createdAt)
    .orderBy(sql`${papers.year} desc nulls last`, desc(papers.createdAt))
    .limit(limit);
  const ids = rows.map((row) => row.paperId);
  const identifiers =
    ids.length > 0
      ? await database
          .select({ paperId: paperIdentifiers.paperId, scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
          .from(paperIdentifiers)
          .where(inArray(paperIdentifiers.paperId, ids))
      : [];
  return rows.map((row) => {
    const id = canonicalPaperId(identifiers.filter((i) => i.paperId === row.paperId));
    return { ...row, address: id ? { kind: 'paper', id: { scheme: id.scheme, value: id.value } } : null };
  });
}

/** A page of another scope that a scope's papers are in, with how many of them are. */
export interface OverlapPage {
  pageId: string;
  key: string;
  name: string;
  papers: number;
}

/**
 * The pages of `kind` that a scope's papers (rolled up) are in directly, by how many of its papers each has, most
 * first: an org's venues (editions) and topics, a topic's venues and orgs.
 */
export async function scopeOverlap(
  scopeId: string,
  kind: 'venue' | 'topic' | 'org',
  options: { limit?: number; database?: Database } = {},
): Promise<OverlapPage[]> {
  const { limit = 10, database = getDb() } = options;
  const { rows } = await database.execute<{ page_id: string; key: string; name: string | null; papers: number }>(sql`
    with mine as (
      select distinct m.paper_id
        from page_members m
       where m.scope_page_id = ${scopeId}
          or m.scope_page_id in (select page_id from page_ancestors where ancestor_id = ${scopeId})
    )
    select p.id as page_id, p.key, c.name, count(distinct o.paper_id)::int as papers
      from mine
      join page_members o on o.paper_id = mine.paper_id
      join pages p on p.id = o.scope_page_id and p.kind = ${kind}
      left join page_current c on c.page_id = p.id
     where p.id <> ${scopeId}
     group by p.id, p.key, c.name
     order by papers desc, p.key
     limit ${limit}
  `);
  return rows.map((row) => ({ pageId: row.page_id, key: row.key, name: row.name ?? row.key, papers: row.papers }));
}
