import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import type { PageKind } from '@/lib/kinds';
import type { PageSummary } from '@/lib/plugins/protocol';
import { ApiError } from './api/errors';
import { listen } from './consumers/worker';
import { pageSummaries } from './plugins/pages';

/**
 * The events feed (`GET /api/v1/events`, `handoffs/signals.md`): every commit to every page, oldest first, from a
 * cursor, for a publisher's backend that keeps its signals current. Unlike `/changes` (newest first, for people), it
 * never skips an event: it reads `page_events` as the outbox consumers do (`consumers/run.ts`), in transaction order,
 * and only events whose transactions have all ended, so a commit that finished late still comes after the cursor.
 *
 * A paper's first commit is its creation (`created`). A merge is a commit to the surviving paper that names the paper
 * merged into it (`merged`), whose identifiers now lead to the survivor. Papers are never deleted.
 *
 * The cursor is `<xid>-<id>`: the last event's transaction and id, or (`next` when nothing more is ready) the oldest
 * transaction still running and 0, which every later event comes after. With `wait`, a request with nothing to give
 * holds on until an event commits or the time is up, so a backend can loop on it.
 */

/** Events a call gives at most. */
export const MAX_EVENTS = 500;
/** Events a call reads at most, before filtering by kind: a narrow filter still answers quickly. */
const SCAN = 2000;
/** Longest `wait`, under Cloudflare's 100 s. */
export const MAX_WAIT_S = 25;
/** How often a waiting request looks again without a notification: one can be missed, or held behind a long transaction. */
const RECHECK_MS = 5_000;

const CURSOR_RE = /^(\d{1,20})-(\d{1,20})$/;

export interface FeedEvent {
  /** This event's cursor: read `after` it to get the events that follow. */
  cursor: string;
  type: 'page.committed';
  at: string;
  page: PageSummary & {
    /** A paper's every identifier (`openreview:abc`, `arxiv:2401.01234`). */ identifiers?: string[];
  };
  seq: number;
  oid: string;
  parent: string | null;
  kind: 'edit' | 'revert';
  summary: string;
  /** The files the commit changed. */
  paths: string[];
  bot: boolean;
  /** The page's first commit. */
  created: boolean;
  /** A merge: the paper merged into this one, whose identifiers now lead here. */
  merged?: { identifier: string | null; identifiers: string[] };
}

export interface FeedPage {
  events: FeedEvent[];
  /** Where to read on from. */
  next: string;
  /** More events are ready now: read again at once. */
  more: boolean;
}

interface Position {
  xid: string;
  id: string;
}

export function parseCursor(cursor: string): Position {
  const m = CURSOR_RE.exec(cursor);
  if (!m) throw new ApiError(400, 'validation_error', '`after` is a cursor from this feed (`next`), or `now`');
  return { xid: m[1], id: m[2] };
}

const cursorOf = (p: Position) => `${p.xid}-${p.id}`;

/** The oldest transaction still running: every event of an older one is in, and every later event comes after it. */
async function horizon(database: Database): Promise<string> {
  const { rows } = await database.execute<{ xmin: string }>(
    sql`select pg_snapshot_xmin(pg_current_snapshot())::text as xmin`,
  );
  return rows[0].xmin;
}

/** One read of the feed, without waiting. `after` `now` starts at the present, with no events. */
export async function readFeed(
  options: { after?: string; kinds?: PageKind[]; limit?: number },
  database: Database = getDb(),
): Promise<FeedPage> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), MAX_EVENTS);
  const top = await horizon(database);
  if (options.after === 'now') return { events: [], next: cursorOf({ xid: top, id: '0' }), more: false };
  const after = options.after ? parseCursor(options.after) : { xid: '0', id: '0' };
  const scanned = (
    await database.execute<{ id: string; xid: string; page_id: string; kind: PageKind }>(sql`
      select e.id::text as id, e.xid::text as xid, e.page_id, p.kind
        from page_events e
        join pages p on p.id = e.page_id
       where (e.xid, e.id) > (${after.xid}::xid8, ${after.id}::bigint)
         and e.xid < ${top}::xid8
       order by e.xid, e.id
       limit ${SCAN}
    `)
  ).rows;
  const kinds = options.kinds?.length ? new Set(options.kinds) : null;
  const picked = (kinds ? scanned.filter((r) => kinds.has(r.kind)) : scanned).slice(0, limit);
  let next: Position;
  let more: boolean;
  if (picked.length === limit) {
    next = picked[picked.length - 1];
    more = true;
  } else if (scanned.length === SCAN) {
    next = scanned[scanned.length - 1];
    more = true;
  } else {
    next = { xid: top, id: '0' };
    more = false;
  }
  return { events: await describeEvents(picked, database), next: cursorOf(next), more };
}

async function describeEvents(picked: { id: string; xid: string }[], database: Database): Promise<FeedEvent[]> {
  if (picked.length === 0) return [];
  const ids = picked.map((r) => r.id);
  const { rows } = await database.execute<{
    id: string;
    page_id: string;
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(sql`
    select e.id::text as id, e.page_id, e.seq, e.type, e.payload, e.created_at
      from page_events e
     where e.id in (${sql.join(
       ids.map((id) => sql`${id}::bigint`),
       sql`, `,
     )})
  `);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const merged = rows.map((r) => r.payload.mergedFrom).filter((x): x is string => typeof x === 'string');
  const pageIds = [...new Set([...rows.map((r) => r.page_id), ...merged])];
  const [summaries, identifiers] = await Promise.all([
    pageSummaries(pageIds, database),
    paperIdentifiers(pageIds, database),
  ]);
  const out: FeedEvent[] = [];
  for (const p of picked) {
    const row = byId.get(p.id);
    const page = row && summaries.get(row.page_id);
    if (!row || !page) continue;
    const payload = row.payload;
    const from = typeof payload.mergedFrom === 'string' ? payload.mergedFrom : null;
    out.push({
      cursor: cursorOf(p),
      type: 'page.committed',
      at: new Date(row.created_at).toISOString(),
      page: { ...page, ...(page.kind === 'paper' ? { identifiers: identifiers.get(row.page_id) ?? [] } : {}) },
      seq: row.seq,
      oid: String(payload.oid ?? ''),
      parent: typeof payload.parent === 'string' ? payload.parent : null,
      kind: payload.kind === 'revert' ? 'revert' : 'edit',
      summary: String(payload.summary ?? ''),
      paths: Array.isArray(payload.paths) ? (payload.paths as string[]) : [],
      bot: payload.bot === true,
      created: payload.parent === null,
      ...(from
        ? {
            merged: {
              identifier: summaries.get(from)?.identifier ?? null,
              identifiers: identifiers.get(from) ?? [],
            },
          }
        : {}),
    });
  }
  return out;
}

/** Each paper's identifiers, `scheme:value`, by paper id; pages that aren't papers have none. */
async function paperIdentifiers(ids: string[], database: Database): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const { rows } = await database.execute<{ paper_id: string; identifier: string }>(sql`
    select paper_id, scheme || ':' || value as identifier
      from paper_identifiers
     where paper_id in (${sql.join(
       ids.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     order by scheme, value
  `);
  for (const r of rows) {
    const list = out.get(r.paper_id) ?? [];
    list.push(r.identifier);
    out.set(r.paper_id, list);
  }
  return out;
}

/**
 * Reads the feed, and with nothing ready waits up to `waitMs` for an event: woken by the commit's notification
 * (`pg_notify` in `recordCommit`, one `LISTEN` connection a process), and looking again every few seconds anyway.
 */
export async function waitForFeed(
  options: { after?: string; kinds?: PageKind[]; limit?: number; waitMs?: number; signal?: AbortSignal },
  database: Database = getDb(),
): Promise<FeedPage> {
  const deadline = Date.now() + Math.min(options.waitMs ?? 0, MAX_WAIT_S * 1000);
  let page = await readFeed(options, database);
  while (page.events.length === 0 && !page.more && Date.now() < deadline && !options.signal?.aborted) {
    await nextEvent(Math.min(RECHECK_MS, deadline - Date.now()), options.signal);
    // From where the last read got to: the present after `now`, and past events another kind's filter skipped.
    page = await readFeed({ ...options, after: page.next }, database);
  }
  return page;
}

declare global {
  var __potentialpaperEventsBell: { waiters: Set<() => void> } | undefined;
}

/** Resolves on the next notification of a commit, after `ms`, or on abort. */
function nextEvent(ms: number, signal?: AbortSignal): Promise<void> {
  const bell = eventsBell();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bell?.waiters.delete(done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    bell?.waiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** The process's one `LISTEN` connection for waiting readers, opened on first use; `null` without a database URL. */
function eventsBell(): { waiters: Set<() => void> } | null {
  if (globalThis.__potentialpaperEventsBell) return globalThis.__potentialpaperEventsBell;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const bell = { waiters: new Set<() => void>() };
  const ring = () => {
    const waiting = [...bell.waiters];
    bell.waiters.clear();
    for (const wake of waiting) wake();
  };
  listen(url, ring, (line) => console.error(line.replace(/^worker:/, 'events feed:')));
  globalThis.__potentialpaperEventsBell = bell;
  return bell;
}
