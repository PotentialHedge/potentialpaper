import { and, eq } from 'drizzle-orm';
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
 * The page an address names, or `null` (following an old key's redirect): a paper through its identifiers (following a merge to the paper that
 * survived it), any other kind by its key. Never asks a paper source, so it is safe on unbounded input.
 */
export async function findPageByAddress(db: Reader, address: PageAddress): Promise<PageRow | null> {
  if (address.kind !== 'paper') {
    return (await findKeyedPage(db, address.kind, address.key)) ?? redirectedPage(db, address.kind, address.key);
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
