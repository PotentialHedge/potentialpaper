import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import type { PageKind } from '@/lib/kinds';
import { LINKS_FILE } from '@/lib/labeled-links';
import type { PageSummary } from '@/lib/plugins/protocol';
import { claimNames } from './claims';
import { handlesOf } from './pages/edit';
import { SYSTEM_AUTHOR_ID } from './pages/git-objects';
import { pageSummaries } from './plugins/pages';

/**
 * The patrol feed (DESIGN.md §7, `/changes`): every commit to every page, newest first, in the outbox's order, for the
 * people who keep the pages honest. Bots' commits are hidden unless asked for, as in every feed. It filters by kind of
 * page.
 *
 * **Public**, as each page's history is: who made a commit is shown as the history shows it, a handle (`u_`), a
 * confirmed author's name on their own paper (`a_`), or the system; never an account id.
 */

export interface ChangeFilter {
  kind?: PageKind;
  /** Bots' commits too. */
  bots?: boolean;
  /** Older than this event. */
  before?: number;
  limit?: number;
}

export interface Change {
  /** Its outbox event, which pages the feed (`before`). */
  id: number;
  page: PageSummary;
  seq: number;
  oid: string;
  summary: string;
  kind: 'edit' | 'revert';
  paths: string[];
  bytesDelta: number;
  at: Date;
  /** A handle, a bot's ending in `[bot]`; `null` for the system or a paper's author. */
  handle: string | null;
  /** One of the paper's confirmed authors, by the name on the paper. */
  authorName: string | null;
  bot: boolean;
  /** It changed a `links.jsonl`. */
  links: boolean;
}

export async function recentChanges(filter: ChangeFilter = {}, database: Database = getDb()): Promise<Change[]> {
  const { kind, bots = false, before, limit = 50 } = filter;
  const conditions = [sql`true`];
  if (kind) conditions.push(sql`pg.kind = ${kind}`);
  if (!bots) conditions.push(sql`not coalesce(a.is_bot, false)`);
  if (before !== undefined) conditions.push(sql`e.id < ${before}`);
  const { rows } = await database.execute<{
    id: string;
    page_id: string;
    page_kind: PageKind;
    seq: number;
    oid: string;
    author_id: string;
    summary: string;
    kind: 'edit' | 'revert';
    paths: string[];
    bytes_delta: number;
    at: Date;
    bot: boolean | null;
  }>(sql`
    select e.id, r.page_id, pg.kind as page_kind, r.seq, encode(r.oid, 'hex') as oid, r.author_id, r.summary, r.kind,
           r.paths, r.bytes_delta, r.at, a.is_bot as bot
      from page_events e
      join page_revisions r on r.page_id = e.page_id and r.seq = e.seq
      join pages pg on pg.id = r.page_id
      left join accounts a on a.id = r.account_id
     where ${sql.join(conditions, sql` and `)}
     order by e.id desc
     limit ${limit}
  `);
  const ids = rows.map((row) => row.author_id);
  const [summaries, handles, names] = await Promise.all([
    pageSummaries(
      rows.map((row) => row.page_id),
      database,
    ),
    handlesOf(ids, database),
    claimNames(ids, database),
  ]);
  const out: Change[] = [];
  for (const row of rows) {
    const page = summaries.get(row.page_id);
    if (!page) continue;
    out.push({
      id: Number(row.id),
      page,
      seq: row.seq,
      oid: row.oid,
      summary: row.summary,
      kind: row.kind,
      paths: row.paths,
      bytesDelta: row.bytes_delta,
      at: new Date(row.at),
      handle: row.author_id === SYSTEM_AUTHOR_ID ? null : (handles.get(row.author_id) ?? null),
      authorName: names.get(row.author_id) ?? null,
      bot: Boolean(row.bot),
      links: row.paths.some((path) => path === LINKS_FILE || path.endsWith(`/${LINKS_FILE}`)),
    });
    if (out.length === limit) break;
  }
  return out;
}

/** The feed as the API gives it (`GET /api/v1/changes`). */
export function presentChanges(changes: readonly Change[], limit: number) {
  return {
    changes: changes.map((c) => ({
      id: c.id,
      page: { kind: c.page.kind, identifier: c.page.identifier, url: c.page.url, name: c.page.name },
      seq: c.seq,
      oid: c.oid,
      summary: c.summary,
      kind: c.kind,
      paths: c.paths,
      bytesDelta: c.bytesDelta,
      at: c.at.toISOString(),
      by: c.authorName ? { authorName: c.authorName } : c.handle ? { handle: c.handle } : { system: true as const },
      bot: c.bot,
      links: c.links,
    })),
    next: changes.length === limit ? changes[changes.length - 1].id : null,
  };
}
