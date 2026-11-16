import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageAncestors, pageMembers, pageMemberSources, pageParents, pageScopeNames } from '@/db/schema';
import { formatIdentifier, KINDS, parentsOf, sourcesOf } from '@/lib/kinds';
import { TOPIC_LABELS } from '@/lib/labeled-links';
import { parseReviewFile, parseReviewPath } from '@/lib/review-files';
import type { Consumer } from './consumers/types';
import { readPageLinks } from './page-links';
import { mustPage, type PageRow } from './pages/kinds';
import { readCommit, readFiles, readText, type Reader } from './pages/repo';
import type { Writer } from './pages/projections';

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
 * whichever page changed first, and both halves come from the repos alone, which makes a rebuild give the same
 * rows. Orgs' members (claims and printed domains) come with `handoffs/pages.md` Phase 4.
 */

interface MemberSource {
  via: string;
  source: string;
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

/** Joins the paper's rows of `page_members` again from its sources and the scopes' names. */
async function joinPaper(tx: Writer, paperId: string): Promise<void> {
  await tx.delete(pageMembers).where(eq(pageMembers.paperId, paperId));
  await tx.execute(sql`
    insert into page_members (scope_page_id, paper_id, via)
    select distinct n.page_id, s.paper_id, s.via
      from page_member_sources s
      join page_scope_names n on n.name = s.source
     where s.paper_id = ${paperId}
    on conflict do nothing
  `);
}

/** Joins the scope's rows of `page_members` again from its names and the papers' sources. */
async function joinScope(tx: Writer, scopeId: string): Promise<void> {
  await tx.delete(pageMembers).where(eq(pageMembers.scopePageId, scopeId));
  await tx.execute(sql`
    insert into page_members (scope_page_id, paper_id, via)
    select distinct n.page_id, s.paper_id, s.via
      from page_scope_names n
      join page_member_sources s on s.source = n.name
     where n.page_id = ${scopeId}
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
      await tx.delete(pageMemberSources).where(eq(pageMemberSources.paperId, pageId));
      if (sources.length > 0) {
        await tx.insert(pageMemberSources).values(sources.map((s) => ({ paperId: pageId, ...s })));
      }
      await joinPaper(tx, pageId);
    });
    return;
  }
  if (!KINDS[page.kind].scope) return;

  let kindFile: unknown = null;
  try {
    kindFile = JSON.parse((await readText(database, pageId, files.get(KINDS[page.kind].kindFile))) ?? 'null');
  } catch {
    // A kind file that doesn't parse names no sources and no parents.
  }
  const names = [formatIdentifier({ kind: page.kind, key: page.key }), ...sourcesOf(page.kind, kindFile)];
  const parents = parentsOf(page.kind, page.key, kindFile);
  await database.transaction(async (tx) => {
    await tx.delete(pageScopeNames).where(eq(pageScopeNames.pageId, pageId));
    await tx.insert(pageScopeNames).values([...new Set(names)].map((name) => ({ pageId, name })));
    await tx.delete(pageParents).where(eq(pageParents.pageId, pageId));
    if (parents.length > 0) await tx.insert(pageParents).values(parents.map((parent) => ({ pageId, parent })));
    await joinScope(tx, pageId);
    // One writer at a time rebuilds the closure: the consumer runs once per lease, but a rebuild may overlap.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('page-ancestors', 0))`);
    await closeAncestors(tx);
  });
}

export const membersConsumer: Consumer = {
  name: 'members',
  async handle(pageId, head, { database }) {
    await indexMembers(database, pageId, head);
  },
  async reset({ database }) {
    await database.execute(
      sql`truncate page_members, page_member_sources, page_scope_names, page_parents, page_ancestors`,
    );
  },
};

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
