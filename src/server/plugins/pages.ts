import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageAncestors, pageCurrent, pageMembers, pages, paperIdentifiers, papers } from '@/db/schema';
import { formatIdentifier, KINDS, pageName, pagePath, partsOf, type PageAddress } from '@/lib/kinds';
import { canonicalPaperId } from '@/lib/paper-ids';
import type { PageSummary } from '@/lib/plugins/protocol';
import { scoreTable, type Submission } from '@/lib/submissions';
import { ApiError } from '../api/errors';
import { linksFrom, type PageLink } from '../page-links';
import { rolledUp, scopeMemberCount, scopeMembers } from '../page-members';
import { pageHasSignals } from '../signals';
import { findPage, type PageRow } from '../pages/kinds';
import { readCommit, readFiles } from '../pages/repo';
import { readSections, sectionTitle } from '../pages/sections';
import type { PagePart } from '../pages/rules';
import { siteUrl } from '../site';
import { submissionsOf } from '../submissions';
import { type UserPageView, userPageView } from '../user-pages';

/**
 * Pages of every kind as plugins read them (`handoffs/plugins.md` Phase 2): the summaries `page.resolve` and
 * `context.get` give, `page.read`'s files, `page.members`' papers and `reviews.forPaper`'s submissions. Also the
 * public REST routes under `/api/v1/pages/{identifier}`, so a plugin's own backend reads the same data.
 *
 * **Only what the page shows the public.** A plugin sees exactly what a reader of the page does; a user page's is its
 * `owners/` and links and never anything that ties the handle to an author identity (DESIGN.md §5.3), and that rule
 * lives here, in what the `user` kind gives, not in the plugins.
 */

function summary(address: PageAddress, name: string, kind = address.kind): PageSummary {
  const path = pagePath(address);
  return { kind, identifier: formatIdentifier(address), address: path, url: `${siteUrl()}${path}`, name };
}

/** Summaries of pages by id, in the order given; pages with no address (a paper with no identifier) are left out. */
export async function pageSummaries(
  ids: readonly string[],
  database: Database = getDb(),
): Promise<Map<string, PageSummary>> {
  const out = new Map<string, PageSummary>();
  if (ids.length === 0) return out;
  const rows = await database
    .select({
      id: pages.id,
      kind: pages.kind,
      key: pages.key,
      shortId: pages.shortId,
      name: pageCurrent.name,
      title: papers.title,
    })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .leftJoin(papers, eq(papers.id, pages.id))
    .where(inArray(pages.id, [...new Set(ids)]));
  const paperIds = rows.filter((row) => row.kind === 'paper').map((row) => row.id);
  const identifiers =
    paperIds.length > 0
      ? await database
          .select({ paperId: paperIdentifiers.paperId, scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
          .from(paperIdentifiers)
          .where(inArray(paperIdentifiers.paperId, paperIds))
      : [];
  for (const row of rows) {
    if (row.kind === 'paper') {
      const id = canonicalPaperId(identifiers.filter((i) => i.paperId === row.id));
      if (id)
        out.set(
          row.id,
          summary({ kind: 'paper', id: { scheme: id.scheme, value: id.value }, shortId: row.shortId }, row.title ?? ''),
        );
    } else {
      out.set(row.id, summary({ kind: row.kind, key: row.key }, row.name ?? pageName(row.kind, row.key, null)));
    }
  }
  return out;
}

/** The page an identifier names, or a 404. */
export async function mustFindPage(identifier: string, database: Database = getDb()): Promise<PageRow> {
  const page = await findPage(identifier, database);
  if (!page) throw new ApiError(404, 'not_found', `no page is ${identifier}`);
  return page;
}

/**
 * The pages above a page: a paper's venues, categories and orgs (`page_members`); any other page's parents (an edition's
 * series, an org's parents), as far as they exist.
 */
export async function scopesOfPage(page: PageRow, database: Database = getDb()): Promise<PageSummary[]> {
  const ids =
    page.kind === 'paper'
      ? (
          await database
            .selectDistinct({ id: pageMembers.scopePageId })
            .from(pageMembers)
            .where(eq(pageMembers.paperId, page.id))
        ).map((row) => row.id)
      : (
          await database
            .select({ id: pageAncestors.ancestorId })
            .from(pageAncestors)
            .where(and(eq(pageAncestors.pageId, page.id), eq(pageAncestors.depth, 1)))
        ).map((row) => row.id);
  const found = await pageSummaries(ids, database);
  return ids.flatMap((id) => (found.has(id) ? [found.get(id)!] : []));
}

/** Whether a paper's submissions have scores (a review with a score field), for `page.hasScores`. */
export function submissionsHaveScores(list: readonly Submission[]): boolean {
  return list.some((s) => scoreTable(s) !== null);
}

/**
 * What `when` conditions test about a page: `page.hasSubmissions` (a paper with a submission, a scope with a paper
 * submitted to it) and `page.hasScores` (a paper whose reviews have scores; a scope with score statistics, `scope_stats`).
 */
export async function pageFacts(
  page: PageRow,
  database: Database = getDb(),
): Promise<{ hasScores: boolean; hasSubmissions: boolean; hasSignals: boolean }> {
  if (page.kind === 'paper') {
    const [list, signals] = await Promise.all([submissionsOf(page.id, database), pageHasSignals(page, database)]);
    return { hasSubmissions: list.length > 0, hasScores: submissionsHaveScores(list), hasSignals: signals };
  }
  if (!KINDS[page.kind].scope) return { hasScores: false, hasSubmissions: false, hasSignals: false };
  const [row] = await database
    .execute<{ submissions: boolean; scores: boolean }>(
      sql`
    select
      exists (select 1 from ${pageMembers} where ${rolledUp(page.id)} and ${pageMembers.via} = 'submission') as submissions,
      exists (select 1 from scope_stats where scope_page_id = ${page.id} and count > 0) as scores
  `,
    )
    .then((result) => result.rows);
  return {
    hasSubmissions: Boolean(row?.submissions),
    hasScores: Boolean(row?.scores),
    hasSignals: await pageHasSignals(page, database),
  };
}

/** The scope an identifier names, or a 404, or a 422 for a page of a kind that has no papers. */
export async function mustFindScope(identifier: string, database: Database = getDb()): Promise<PageRow> {
  const page = await mustFindPage(identifier, database);
  if (!KINDS[page.kind].scope) {
    throw new ApiError(422, 'validation_error', `a ${KINDS[page.kind].title.toLowerCase()} page has no papers`);
  }
  return page;
}

/** `page.resolve`, `GET /pages/{identifier}`: a page's summary, its scopes and its facts. */
export async function resolvePage(identifier: string, database: Database = getDb()) {
  const page = await mustFindPage(identifier, database);
  const [found, scopes, facts] = await Promise.all([
    pageSummaries([page.id], database),
    scopesOfPage(page, database),
    pageFacts(page, database),
  ]);
  const self = found.get(page.id);
  if (!self) throw new ApiError(404, 'not_found', `no page is ${identifier}`);
  return { ...self, scopes, facts };
}

function presentLink(link: PageLink) {
  return {
    label: link.label,
    origin: link.origin,
    to: link.page.url ?? (link.page.address ? formatIdentifier(link.page.address) : null),
    name: link.page.name,
    note: link.note,
    fromAnchor: link.fromAnchor,
    toAnchor: link.toAnchor,
    evidence: link.evidence,
  };
}

/**
 * `page.read`, `GET /pages/{identifier}/files`: the page's kind file, its sections (Markdown, in order, part by part)
 * and its labeled links, at its current commit. A paper's "kind file" is its metadata. A user page gives its
 * `owners/`, its links, and `userKindFile`: only what its account shows (`server/user-pages.ts`).
 */
export async function readPageForPlugins(identifier: string, database: Database = getDb()) {
  const page = await mustFindPage(identifier, database);
  const [found, [current], links] = await Promise.all([
    pageSummaries([page.id], database),
    database
      .select({ head: pageCurrent.head, kindFile: pageCurrent.kindFile })
      .from(pageCurrent)
      .where(eq(pageCurrent.pageId, page.id)),
    linksFrom(page.id, database),
  ]);
  const self = found.get(page.id);
  if (!self) throw new ApiError(404, 'not_found', `no page is ${identifier}`);

  let kindFile: Record<string, unknown> | null;
  if (page.kind === 'paper') {
    const [paper] = await database
      .select({
        title: papers.title,
        authors: papers.authors,
        abstract: papers.abstract,
        year: papers.year,
        venue: papers.venue,
      })
      .from(papers)
      .where(eq(papers.id, page.id));
    const ids = await database
      .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
      .from(paperIdentifiers)
      .where(eq(paperIdentifiers.paperId, page.id));
    kindFile = paper ? { ...paper, identifiers: ids.map((id) => `${id.scheme}:${id.value}`) } : null;
  } else if (page.kind === 'user') {
    // Only what the account shows the public (DESIGN.md §5.3), from the same view the page draws.
    const view = await userPageView(page, { limit: 0 }, database);
    kindFile = view ? userKindFile(view) : {};
  } else {
    kindFile = current?.kindFile ?? null;
  }

  const sections: { part: string; path: string; title: string; markdown: string }[] = [];
  let commit: string | null = null;
  if (current) {
    commit = current.head.toString('hex');
    const files = await readFiles(database, page.id, (await readCommit(database, page.id, commit)).tree);
    for (const part of partsOf(page.kind)) {
      for (const section of await readSections(database, page.id, files, part as PagePart)) {
        sections.push({ part, path: section.path, title: sectionTitle(section), markdown: section.text });
      }
    }
  }
  return { page: self, kindFile, sections, links: links.map(presentLink), commit };
}

/**
 * A person's page has no files; plugins and the public routes read this in place of a kind file: what the account
 * chose to show, its bio and links, and the values of the items it shows (its real name, institutions, the papers it
 * authored), nothing else.
 */
export function userKindFile(view: UserPageView): Record<string, unknown> {
  return {
    show: view.shown,
    ...(view.bio ? { bio: view.bio } : {}),
    ...Object.fromEntries(Object.entries(view.links).filter(([, value]) => value)),
    ...(view.realName ? { realName: view.realName } : {}),
    ...(view.institutions ? { institutions: view.institutions } : {}),
    ...(view.claimedPapers
      ? { papers: view.claimedPapers.map((p) => ({ identifier: p.page.identifier, authorName: p.authorName })) }
      : {}),
  };
}

/** `page.members`, `GET /pages/{identifier}/members`: a scope's papers, a page at a time, rolled up by default. */
export async function pageMembersForPlugins(
  identifier: string,
  options: { offset: number; limit: number; rollUp: boolean },
  database: Database = getDb(),
) {
  const page = await mustFindPage(identifier, database);
  if (!KINDS[page.kind].scope) {
    throw new ApiError(422, 'validation_error', `a ${KINDS[page.kind].title.toLowerCase()} page has no papers`);
  }
  const [total, members] = await Promise.all([
    scopeMemberCount(page.id, { rollUp: options.rollUp, database }),
    scopeMembers(page.id, { ...options, database }),
  ]);
  const found = await pageSummaries(
    members.map((m) => m.paperId),
    database,
  );
  const years = new Map(
    members.length
      ? (
          await database
            .select({ id: papers.id, year: papers.year })
            .from(papers)
            .where(
              inArray(
                papers.id,
                members.map((m) => m.paperId),
              ),
            )
        ).map((row) => [row.id, row.year])
      : [],
  );
  const list = members.flatMap((m) =>
    found.has(m.paperId) ? [{ ...found.get(m.paperId)!, year: years.get(m.paperId) ?? null, via: m.via }] : [],
  );
  const next = options.offset + members.length;
  return { total, papers: list, nextOffset: members.length === options.limit && next < total ? next : null };
}

/** `reviews.forPaper`, `GET /pages/{identifier}/submissions`: a paper's submissions, notes and venue forms. */
export async function paperSubmissionsForPlugins(identifier: string, database: Database = getDb()) {
  const page = await mustFindPage(identifier, database);
  if (page.kind !== 'paper') throw new ApiError(422, 'validation_error', `${identifier} is not a paper`);
  const list = await submissionsOf(page.id, database);
  return {
    submissions: list.map((s) => ({
      ...s,
      fetchedAt: s.fetchedAt.toISOString(),
      notes: s.notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    })),
  };
}
