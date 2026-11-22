import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent, pageLinks, pages, paperIdentifiers, papers } from '@/db/schema';
import { formatIdentifier, type PageAddress, parseIdentifier, partsOf } from '@/lib/kinds';
import {
  type LabeledLink,
  LINKS_FILE,
  type LinkLabelName,
  type LinkTargetKind,
  parseLabeledLinks,
} from '@/lib/labeled-links';
import { canonicalPaperId } from '@/lib/paper-ids';
import type { Consumer } from './consumers/types';
import { findPageByAddress, formerKeys, mergedIds, mustPage, type PageRow } from './pages/kinds';
import { refreshPageIds } from './pages/refresh';
import { readCommit, readFiles, readText, type Reader } from './pages/repo';

/**
 * The link index (DESIGN.md §8): `page_links`, kept by the `links` consumer from every page's `<part>/links.jsonl`,
 * on pages of every kind. It answers "what links here" on any page, and lists a page's own links with their
 * targets resolved. Rebuilt with `consumers:rebuild -- links`.
 */

/** The labeled links at a commit of a page, by file, as `page_links` holds them. */
export async function readPageLinks(
  db: Reader,
  page: PageRow,
  files: ReadonlyMap<string, string>,
): Promise<{ path: string; origin: 'owners' | 'community'; link: LabeledLink }[]> {
  const out: { path: string; origin: 'owners' | 'community'; link: LabeledLink }[] = [];
  for (const part of partsOf(page.kind)) {
    const path = `${part}/${LINKS_FILE}`;
    const text = await readText(db, page.id, files.get(path));
    if (text === null) continue;
    // The commit path refuses a bad file, so only an old commit can have one; it then has no links.
    const parsed = parseLabeledLinks(text, page.kind);
    if (!('links' in parsed)) continue;
    const origin = part === 'community' ? 'community' : 'owners';
    for (const link of parsed.links) out.push({ path, origin, link });
  }
  return out;
}

/** Brings one page's rows up to `head`. */
export async function indexPageLinks(database: Database, pageId: string, head: string): Promise<number> {
  const page = await mustPage(database, pageId);
  const commit = await readCommit(database, pageId, head);
  const links = await readPageLinks(database, page, await readFiles(database, pageId, commit.tree));
  const targets = new Map<string, string | null>();
  for (const { link } of links) {
    if (targets.has(link.target)) continue;
    const address = parseIdentifier(link.target);
    targets.set(link.target, address ? ((await findPageByAddress(database, address))?.id ?? null) : null);
  }
  const before = await database
    .select({ target: pageLinks.targetPageId })
    .from(pageLinks)
    .where(eq(pageLinks.pageId, pageId));
  await database.transaction(async (tx) => {
    await tx.delete(pageLinks).where(eq(pageLinks.pageId, pageId));
    if (links.length === 0) return;
    await tx.insert(pageLinks).values(
      links.map(({ path, origin, link }) => ({
        pageId,
        path,
        linkId: link.id,
        line: link.line,
        target: link.target,
        targetKind: link.targetKind,
        targetPageId: targets.get(link.target) ?? null,
        label: link.label,
        origin,
        note: link.note ?? null,
        fromAnchor: link.from_anchor ?? null,
        toAnchor: link.to_anchor ?? null,
        evidence: link.evidence ?? null,
      })),
    );
  });
  // The pages these links name, before and after, show what links to them: they are refreshed as the page is.
  const touched = [...before.map((row) => row.target), ...targets.values()].filter((id) => id !== null);
  await refreshPageIds(database, touched).catch((err) => console.error('refreshing link targets failed', err));
  return links.length;
}

export const linksConsumer: Consumer = {
  name: 'links',
  async handle(pageId, head, { database }) {
    await indexPageLinks(database, pageId, head);
  },
  async reset({ database }) {
    await database.execute(sql`truncate page_links`);
  },
};

/** A page at the other end of a link, as a list shows it. */
export interface LinkedPage {
  pageId: string | null;
  kind: LinkTargetKind;
  /** For a link to an address elsewhere (`web`), the address. */
  url?: string;
  /** Its identifier, which also makes its address (`pagePath`). */
  address: PageAddress | null;
  /** Its title or name; `null` for a page that doesn't exist (yet). */
  name: string | null;
}

export interface PageLink {
  label: LinkLabelName;
  origin: 'owners' | 'community';
  note: string | null;
  fromAnchor: string | null;
  toAnchor: string | null;
  evidence: string | null;
  /** The page at the other end: the target of a link from this page, the source of one to it. */
  page: LinkedPage;
}

/** The pages with these ids, as lists show them: a paper by its canonical identifier and title, others by key and name. */
async function linkedPages(db: Reader, ids: readonly string[]): Promise<Map<string, LinkedPage>> {
  const out = new Map<string, LinkedPage>();
  if (ids.length === 0) return out;
  const rows = await db
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
      ? await db
          .select({ paperId: paperIdentifiers.paperId, scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
          .from(paperIdentifiers)
          .where(inArray(paperIdentifiers.paperId, paperIds))
      : [];
  for (const row of rows) {
    if (row.kind === 'paper') {
      const id = canonicalPaperId(identifiers.filter((i) => i.paperId === row.id));
      out.set(row.id, {
        pageId: row.id,
        kind: 'paper',
        address: id ? { kind: 'paper', id: { scheme: id.scheme, value: id.value }, shortId: row.shortId } : null,
        name: row.title,
      });
    } else {
      out.set(row.id, {
        pageId: row.id,
        kind: row.kind,
        address: { kind: row.kind, key: row.key },
        name: row.name ?? row.key,
      });
    }
  }
  return out;
}

type LinkRow = typeof pageLinks.$inferSelect;

function asLink(row: LinkRow, page: LinkedPage): PageLink {
  return {
    label: row.label as LinkLabelName,
    origin: row.origin,
    note: row.note,
    fromAnchor: row.fromAnchor,
    toAnchor: row.toAnchor,
    evidence: row.evidence,
    page,
  };
}

/** A page's own labeled links, in file order, with their targets as they are now. */
export async function linksFrom(pageId: string, database: Database = getDb()): Promise<PageLink[]> {
  const rows = await database
    .select()
    .from(pageLinks)
    .where(eq(pageLinks.pageId, pageId))
    .orderBy(pageLinks.path, pageLinks.line);
  // A target named before its page existed is found now.
  const resolved = new Map<string, string | null>();
  for (const row of rows) {
    if (row.targetPageId || resolved.has(row.target) || row.targetKind === 'web') continue;
    const address = parseIdentifier(row.target);
    resolved.set(row.target, address ? ((await findPageByAddress(database, address))?.id ?? null) : null);
  }
  const ids = rows.map((row) => row.targetPageId ?? resolved.get(row.target) ?? null).filter((id) => id !== null);
  const found = await linkedPages(database, ids);
  return rows.map((row) => {
    const id = row.targetPageId ?? resolved.get(row.target) ?? null;
    const known = id ? found.get(id) : undefined;
    return asLink(
      row,
      known ??
        (row.targetKind === 'web'
          ? { pageId: null, kind: 'web', address: null, name: null, url: row.target }
          : { pageId: null, kind: row.targetKind, address: parseIdentifier(row.target), name: null }),
    );
  });
}

/** The identifiers a page answers to: a paper's every identifier, another kind's `<kind>:<key>`. */
async function identifiersOf(db: Reader, page: PageRow): Promise<string[]> {
  if (page.kind !== 'paper') {
    // Its old keys too: a renamed category's, those of categories merged into it, a person's old handles.
    const kind = page.kind;
    return [page.key, ...(await formerKeys(db, page))].map((key) => formatIdentifier({ kind, key }));
  }
  const ids = await db
    .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, page.id));
  return ids.map((id) => formatIdentifier({ kind: 'paper', id }));
}

/**
 * "What links here" (DESIGN.md §8): every labeled link to this page from a page of any kind, by the page it was
 * resolved to or by any identifier the page answers to, newest sources first.
 */
export async function linksTo(pageId: string, database: Database = getDb()): Promise<PageLink[]> {
  const page = await mustPage(database, pageId);
  const names = await identifiersOf(database, page);
  const ids = [pageId, ...(await mergedIds(database, pageId))];
  const rows = await database
    .select()
    .from(pageLinks)
    .where(
      and(
        or(inArray(pageLinks.targetPageId, ids), names.length > 0 ? inArray(pageLinks.target, names) : undefined),
        sql`${pageLinks.pageId} <> ${pageId}`,
      ),
    )
    .orderBy(pageLinks.pageId, pageLinks.path, pageLinks.line);
  const found = await linkedPages(
    database,
    rows.map((row) => row.pageId),
  );
  return rows.flatMap((row) => {
    const source = found.get(row.pageId);
    return source ? [asLink(row, source)] : [];
  });
}
