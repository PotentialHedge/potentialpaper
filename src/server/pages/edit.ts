import { eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, commitIdentities } from '@/db/schema';
import { claimNames } from '../claims';
import { SYSTEM_AUTHOR_ID } from './git-objects';
import { pageHistory, type PublicRevision } from './repo';

export interface HistoryEntry extends PublicRevision {
  /** Who made it: a handle, or `null` for the system or one of the paper's authors. */
  handle: string | null;
  /** One of the paper's confirmed authors, by the name on the paper: their handle never shows here. */
  authorName: string | null;
}

/**
 * A page's history with each commit's handle. **Public:** commit identities are looked up to handles, and
 * nothing here selects an account id.
 */
export async function historyWithHandles(
  paperId: string,
  options: { limit?: number; beforeSeq?: number; database?: Database } = {},
): Promise<HistoryEntry[]> {
  const database = options.database ?? getDb();
  const revisions = await pageHistory(paperId, { ...options, database });
  const ids = revisions.map((r) => r.authorId);
  const [handles, names] = await Promise.all([handlesOf(ids, database), claimNames(ids, database)]);
  return revisions.map((revision) => ({
    ...revision,
    handle: handles.get(revision.authorId) ?? null,
    authorName: names.get(revision.authorId) ?? null,
  }));
}

/** Handles by commit identity. Only the two columns cross: the account id stays in the join. */
export async function handlesOf(
  authorIds: readonly string[],
  database: Database = getDb(),
): Promise<Map<string, string>> {
  const ids = [...new Set(authorIds)].filter((id) => id !== SYSTEM_AUTHOR_ID && id.startsWith('u_'));
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({ id: commitIdentities.id, handle: accounts.handle })
    .from(commitIdentities)
    .innerJoin(accounts, eq(accounts.id, commitIdentities.accountId))
    .where(inArray(commitIdentities.id, ids));
  return new Map(rows.map((row) => [row.id, row.handle]));
}
