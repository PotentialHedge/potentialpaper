import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pgErrorCode } from '@/db/errors';
import { pageRedirects, pages, paperIdentifiers, papers } from '@/db/schema';
import {
  type KeyedKind,
  keyedPagePath,
  keyProblem,
  KINDS,
  type PageAddress,
  type PageKind,
  pagePath,
  parseIdentifier,
} from '@/lib/kinds';
import { canonicalPaperId, type PaperId } from '@/lib/paper-ids';
import { ApiError } from '../api/errors';
import type { Reader } from './repo';

/**
 * Pages of every kind (`lib/kinds.ts`) as rows of `pages`: finding one by its public identifier or its address,
 * and making one. A paper's row is made with the paper (`schema.ts`), so only other kinds are made here.
 */

export interface PageRow {
  id: string;
  kind: PageKind;
  key: string;
}

/** A page by id, or `null`. */
export async function pageOf(db: Reader, pageId: string): Promise<PageRow | null> {
  const [row] = await db
    .select({ id: pages.id, kind: pages.kind, key: pages.key })
    .from(pages)
    .where(eq(pages.id, pageId));
  return row ?? null;
}

/** A page by id, or a 404. */
export async function mustPage(db: Reader, pageId: string): Promise<PageRow> {
  const page = await pageOf(db, pageId);
  if (!page) throw new ApiError(404, 'not_found', 'no such page');
  return page;
}

/** A keyed page by its kind and key, or `null`. */
export async function findKeyedPage(db: Reader, kind: KeyedKind, key: string): Promise<PageRow | null> {
  const [row] = await db
    .select({ id: pages.id, kind: pages.kind, key: pages.key })
    .from(pages)
    .where(and(eq(pages.kind, kind), eq(pages.key, key)));
  return row ?? null;
}

/**
 * The page an old key leads to (`page_redirects`): a user page whose account changed its handle, until another account
 * takes the old one. `null` if none.
 */
export async function redirectedPage(db: Reader, kind: KeyedKind, key: string): Promise<PageRow | null> {
  const [row] = await db
    .select({ id: pages.id, kind: pages.kind, key: pages.key })
    .from(pageRedirects)
    .innerJoin(pages, eq(pages.id, pageRedirects.pageId))
    .where(and(eq(pageRedirects.kind, kind), eq(pageRedirects.key, key)));
  return row ?? null;
}

/**
 * The page a keyed page was merged into, as far as merges go (a topic merged into one later merged again), or the page
 * itself if it wasn't (`pages.merged_into`, `topic-pages.ts`).
 */
export async function survivorOf(db: Reader, page: PageRow): Promise<PageRow> {
  let current = page;
  for (let hops = 0; hops < 8; hops += 1) {
    const [row] = await db.select({ mergedInto: pages.mergedInto }).from(pages).where(eq(pages.id, current.id));
    if (!row?.mergedInto) return current;
    const next = await pageOf(db, row.mergedInto);
    if (!next) return current;
    current = next;
  }
  return current;
}

/**
 * The page an address names, or `null`, following an old key's redirect and a merge: a paper through its identifiers
 * (to the paper that survived its merge), any other kind by its key (to the topic it was merged into). Never asks a
 * paper source, so it is safe on unbounded input.
 */
export async function findPageByAddress(db: Reader, address: PageAddress): Promise<PageRow | null> {
  if (address.kind !== 'paper') {
    const page =
      (await findKeyedPage(db, address.kind, address.key)) ?? (await redirectedPage(db, address.kind, address.key));
    return page && survivorOf(db, page);
  }
  const [row] = await db
    .select({ id: papers.id, mergedInto: papers.mergedInto })
    .from(paperIdentifiers)
    .innerJoin(papers, eq(papers.id, paperIdentifiers.paperId))
    .where(and(eq(paperIdentifiers.scheme, address.id.scheme), eq(paperIdentifiers.value, address.id.value)));
  if (!row) return null;
  return pageOf(db, row.mergedInto ?? row.id);
}

/** The page a public identifier names (`venue:iclr/2027`, `arxiv:…`), or `null`. */
export async function findPage(identifier: string, database: Database = getDb()): Promise<PageRow | null> {
  const address = parseIdentifier(identifier);
  return address ? findPageByAddress(database, address) : null;
}

/** A paper's identifiers, for its page's address. */
async function paperIds(db: Reader, paperId: string): Promise<PaperId[]> {
  return db
    .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, paperId));
}

/** A page's public address: a paper's canonical identifier, any other kind's key. `null` for a paper with none. */
export async function addressOf(db: Reader, page: PageRow): Promise<PageAddress | null> {
  if (page.kind !== 'paper') return { kind: page.kind, key: page.key };
  const id = canonicalPaperId(await paperIds(db, page.id));
  return id ? { kind: 'paper', id } : null;
}

/** A page's path on the site, as `addressOf` names it. */
export async function pathOf(db: Reader, page: PageRow): Promise<string | null> {
  if (page.kind !== 'paper') return keyedPagePath(page.kind, page.key);
  const address = await addressOf(db, page);
  return address && pagePath(address);
}

/**
 * Makes the row of a page of a kind other than a paper, or returns the one there is. `createPage` (`commit.ts`) also
 * starts its repo.
 */
export async function insertPage(kind: KeyedKind, key: string, database: Database = getDb()): Promise<PageRow> {
  const problem = keyProblem(kind, key);
  if (problem) throw new ApiError(422, 'validation_error', `a ${KINDS[kind].title.toLowerCase()} key ${problem}`);
  try {
    await database.insert(pages).values({ kind, key }).onConflictDoNothing();
  } catch (err) {
    if (pgErrorCode(err) !== '23505') throw err;
  }
  const page = await findKeyedPage(database, kind, key);
  if (!page) throw new Error(`could not make the ${kind} page ${key}`);
  return page;
}

/**
 * The other keys a keyed page answers to: its old keys (`page_redirects`, a renamed topic's or a person's old handle),
 * and the keys of pages merged into it with theirs (`pages.merged_into`). Links and memberships that name one of these
 * count for the page (`page-links.ts`, `page-members.ts`).
 */
export async function formerKeys(db: Reader, page: PageRow): Promise<string[]> {
  if (page.kind === 'paper') return [];
  const { rows } = await db.execute<{ key: string }>(sql`
    with recursive merged (id) as (
      select id from pages where merged_into = ${page.id}
      union
      select p.id from pages p join merged m on p.merged_into = m.id
    )
    select key from page_redirects where kind = ${page.kind} and page_id = ${page.id}
    union
    select key from pages where id in (select id from merged)
    union
    select key from page_redirects where kind = ${page.kind} and page_id in (select id from merged)
  `);
  return rows
    .map((row) => row.key)
    .filter((key) => key !== page.key)
    .sort();
}

/** The ids of the pages merged into this one, as far as merges go. */
export async function mergedIds(db: Reader, pageId: string): Promise<string[]> {
  const { rows } = await db.execute<{ id: string }>(sql`
    with recursive merged (id) as (
      select id from pages where merged_into = ${pageId}
      union
      select p.id from pages p join merged m on p.merged_into = m.id
    )
    select id from merged
  `);
  return rows.map((row) => row.id);
}
