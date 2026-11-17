import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { KINDS, type PageKind, topicFileSchema } from '@/lib/kinds';
import { LINKS_FILE } from '@/lib/labeled-links';
import type { PageSummary } from '@/lib/plugins/protocol';
import { claimNames } from './claims';
import { handlesOf } from './pages/edit';
import { SYSTEM_AUTHOR_ID } from './pages/git-objects';
import { readCommit, readFiles, readText, type Reader } from './pages/repo';
import { pageSummaries } from './plugins/pages';

/**
 * The patrol feed (DESIGN.md §7, `/changes`): every commit to every page, newest first, in the outbox's order, for the
 * people who keep the pages honest. Bots' commits are hidden unless asked for, as in every feed. It filters by kind of
 * page, and by `rollUp`: changes to a topic's `broader` topics, which move papers between roll-ups (`handoffs/pages.md`
 * Phase 5), and merges and renames, which do too.
 *
 * **Public**, as each page's history is: who made a commit is shown as the history shows it, a handle (`u_`), a
 * confirmed author's name on their own paper (`a_`), or the system; never an account id.
 */

export interface ChangeFilter {
  kind?: PageKind;
  /** Bots' commits too. */
  bots?: boolean;
  /** Only changes that move papers between topics' roll-ups. */
  rollUp?: boolean;
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
  /** It moves papers between roll-ups: a topic's `broader` changed, or a topic was merged or moved. */
  rollUp: boolean;
}

/** The `broader` a topic's `topic.json` gives at a commit, sorted, or `null` if it has none that parses. */
async function broaderAt(db: Reader, pageId: string, oid: string | null): Promise<string[] | null> {
  if (!oid) return null;
  const commit = await readCommit(db, pageId, oid);
  const text = await readText(db, pageId, (await readFiles(db, pageId, commit.tree)).get(KINDS.topic.kindFile));
  try {
    const parsed = topicFileSchema.safeParse(JSON.parse(text ?? 'null'));
    return parsed.success ? [...(parsed.data.broader ?? [])].sort() : null;
  } catch {
    return null;
  }
}

/** Whether a topic's commit changed its `broader`. */
async function changedBroader(db: Reader, pageId: string, oid: string): Promise<boolean> {
  const commit = await readCommit(db, pageId, oid);
  const [after, before] = await Promise.all([broaderAt(db, pageId, oid), broaderAt(db, pageId, commit.parent)]);
  return JSON.stringify(after ?? []) !== JSON.stringify(before ?? []);
}

const MOVES = /^(Merge topic:|Moved from topic:)/;

export async function recentChanges(filter: ChangeFilter = {}, database: Database = getDb()): Promise<Change[]> {
  const { kind, bots = false, rollUp = false, before, limit = 50 } = filter;
  const conditions = [sql`true`];
  if (kind) conditions.push(sql`pg.kind = ${kind}`);
  if (rollUp)
    conditions.push(sql`pg.kind = 'topic' and (${KINDS.topic.kindFile} = any(r.paths) or r.summary ~ ${MOVES.source})`);
  if (!bots) conditions.push(sql`not coalesce(a.is_bot, false)`);
  if (before !== undefined) conditions.push(sql`e.id < ${before}`);
  // A roll-up change is told by reading the commit, so the filter reads more rows than it shows.
  const take = rollUp ? limit * 4 : limit;
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
     limit ${take}
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
    const moves =
      row.page_kind === 'topic' &&
      (MOVES.test(row.summary) ||
        (row.paths.includes(KINDS.topic.kindFile) && (await changedBroader(database, row.page_id, row.oid))));
    if (rollUp && !moves) continue;
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
      rollUp: moves,
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
      rollUp: c.rollUp,
    })),
    next: changes.length === limit ? changes[changes.length - 1].id : null,
  };
}
