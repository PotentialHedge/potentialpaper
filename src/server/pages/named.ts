import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent, pages, papers } from '@/db/schema';
import { type PageAddress, pageName, pagePath } from '@/lib/kinds';
import { findPaper, type FoundPaper } from '../papers';
import { addressOf, findPageByAddress, type PageRow } from './kinds';

/**
 * A page of any kind as everything that shows it needs it: its row, its canonical address (a paper's best-known
 * identifier, any other kind's current key, after redirects and merges), its name and path, and on a paper the paper.
 */
export interface NamedPage {
  page: PageRow;
  address: PageAddress;
  name: string;
  path: string;
  paper: FoundPaper | null;
}

/** The page an address names, as `NamedPage`, or `null` if there is none. */
export async function namedPage(asked: PageAddress, database: Database = getDb()): Promise<NamedPage | null> {
  const page = await findPageByAddress(database, asked);
  const address = page && (await addressOf(database, page));
  if (!page || !address) return null;
  if (address.kind === 'paper') {
    const paper = await findPaper(address.id, database);
    return paper && { page, address, name: paper.paper.title, path: pagePath(address), paper };
  }
  const [current] = await database
    .select({ name: pageCurrent.name })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  return {
    page,
    address,
    name: current?.name ?? pageName(address.kind, address.key, null),
    path: pagePath(address),
    paper: null,
  };
}

/**
 * The page a short address names (`/s/<n>`, as the page tools take it too: `/history/s/<n>`), as `NamedPage`, or
 * `null` if there is none. A merged paper's short address names the paper it was merged into.
 */
export async function namedPageByShortId(shortId: number, database: Database = getDb()): Promise<NamedPage | null> {
  if (!Number.isSafeInteger(shortId) || shortId < 1) return null;
  const [row] = await database.select().from(pages).where(eq(pages.shortId, shortId));
  if (!row) return null;
  let page: PageRow = row;
  for (let hops = 0; page.kind === 'paper' && hops < 8; hops++) {
    const [paper] = await database.select({ mergedInto: papers.mergedInto }).from(papers).where(eq(papers.id, page.id));
    if (!paper?.mergedInto) break;
    const [survivor] = await database.select().from(pages).where(eq(pages.id, paper.mergedInto));
    if (!survivor) break;
    page = survivor;
  }
  const address = await addressOf(database, page);
  return address && namedPage(address, database);
}
