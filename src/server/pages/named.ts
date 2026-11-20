import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent } from '@/db/schema';
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
