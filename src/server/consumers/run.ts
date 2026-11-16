import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import type { Consumer } from './types';

/**
 * Runs outbox consumers over `page_events` (DESIGN.md §4.9).
 *
 * **Why the cursor follows the transaction, not the id.** An event's `id` comes from a sequence when it is
 * inserted, before its transaction commits, so a commit that started first and finished last shows up with an
 * id below events already read, and a cursor on `id` alone would step over it for good. Every event also
 * records its transaction (`xid`, `pg_current_xact_id()`), and a reader only takes events whose transaction
 * is older than the oldest one still running (`pg_snapshot_xmin`): those transactions have all ended, so no
 * more events can appear among them, and new transactions only ever get higher ids. The cursor is the last
 * `(xid, id)` read, in that order. The cost is that one long transaction that has written anything holds
 * every consumer back until it ends; commits themselves are short.
 *
 * Events are read in batches, and each page in a batch is handed over once, at the head of its last event
 * there (its highest `seq`). A page that throws stops the consumer just before that page's first event in the
 * batch, so everything before it is done and nothing after it is skipped; the error is kept in the cursor's
 * row and the consumer tries again once `RETRY_MS` has passed.
 *
 * A lease on the cursor's row (`leased_until`) keeps two workers off one consumer. Its value is the token:
 * a worker only moves the cursor while the lease is still the one it took, so a `consumers:rebuild` (which
 * clears it) or a worker that took over an expired lease stops it at its next step.
 */

/** How many events one step reads. */
export const BATCH_SIZE = 500;
/** How long a lease lasts without being renewed; each batch renews it. */
const LEASE = '2 minutes';
/** How long a consumer that failed waits before trying again. */
export const RETRY_MS = 60_000;

export interface RunOptions {
  database?: Database;
  batchSize?: number;
  /** Ignore the wait after a failure. */
  retryNow?: boolean;
}

export interface RunReport {
  name: string;
  /** Events the cursor moved past. */
  events: number;
  /** Times `handle` was called (once per page per batch). */
  pages: number;
  /** Why it stopped short, if it did. */
  status: 'caught-up' | 'failed' | 'busy' | 'waiting' | 'lease-lost';
  error?: string;
}

interface EventRow extends Record<string, unknown> {
  id: string;
  xid: string;
  paper_id: string;
  head: string | null;
}

interface Position {
  xid: string;
  id: string;
}

function message(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** Takes the consumer's lease, creating its cursor (at zero) the first time. `null` if someone else holds it. */
async function takeLease(
  database: Database,
  name: string,
  retryNow: boolean,
): Promise<{ token: string; position: Position } | { busy: true } | { waiting: true }> {
  await database.execute(sql`insert into consumer_cursors (name) values (${name}) on conflict do nothing`);
  const retry = retryNow
    ? sql`true`
    : sql`(failed_at is null or failed_at < now() - ${`${RETRY_MS} milliseconds`}::interval)`;
  const taken = await database.execute<{ token: string; xid: string; id: string }>(sql`
    update consumer_cursors
       set leased_until = now() + ${LEASE}::interval
     where name = ${name} and (leased_until is null or leased_until < now()) and ${retry}
    returning leased_until::text as token, last_xid::text as xid, last_event_id::text as id
  `);
  const [row] = taken.rows;
  if (row) return { token: row.token, position: { xid: row.xid, id: row.id } };
  const [state] = (
    await database.execute<{ leased: boolean }>(
      sql`select leased_until is not null and leased_until >= now() as leased from consumer_cursors where name = ${name}`,
    )
  ).rows;
  return state?.leased ? { busy: true } : { waiting: true };
}

/** The next events past `after` whose transactions have all ended, in cursor order. */
async function readEvents(database: Database, after: Position, limit: number): Promise<EventRow[]> {
  const result = await database.execute<EventRow>(sql`
    select e.id::text as id, e.xid::text as xid, e.paper_id,
           coalesce(e.payload ->> 'oid', encode(r.head, 'hex')) as head
      from page_events e
      left join page_refs r on r.paper_id = e.paper_id
     where (e.xid, e.id) > (${after.xid}::xid8, ${after.id}::bigint)
       and e.xid < pg_snapshot_xmin(pg_current_snapshot())
     order by e.xid, e.id
     limit ${limit}
  `);
  return result.rows;
}

/** Moves the cursor and renews the lease, if the lease is still ours. Returns the new token, or `null`. */
async function moveCursor(
  database: Database,
  name: string,
  token: string,
  position: Position,
  error: string | null,
): Promise<string | null> {
  const moved = await database.execute<{ token: string }>(sql`
    update consumer_cursors
       set last_xid = ${position.xid}::xid8, last_event_id = ${position.id}::bigint,
           last_error = ${error}, failed_at = ${error === null ? sql`null` : sql`now()`},
           leased_until = now() + ${LEASE}::interval, updated_at = now()
     where name = ${name} and leased_until = ${token}::timestamptz
    returning leased_until::text as token
  `);
  return moved.rows[0]?.token ?? null;
}

async function releaseLease(database: Database, name: string, token: string): Promise<void> {
  await database.execute(
    sql`update consumer_cursors set leased_until = null where name = ${name} and leased_until = ${token}::timestamptz`,
  );
}

/**
 * Brings one consumer up to the newest event it may read: batch after batch until one comes back short, a
 * page fails, or the lease is lost.
 */
export async function runConsumer(consumer: Consumer, options: RunOptions = {}): Promise<RunReport> {
  const database = options.database ?? getDb();
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const report: RunReport = { name: consumer.name, events: 0, pages: 0, status: 'caught-up' };

  const lease = await takeLease(database, consumer.name, options.retryNow ?? false);
  if ('busy' in lease) return { ...report, status: 'busy' };
  if ('waiting' in lease) return { ...report, status: 'waiting' };
  let { token, position } = lease;

  try {
    for (;;) {
      const events = await readEvents(database, position, batchSize);
      if (events.length === 0) return report;

      // Each page once, at its last event in the batch, in the order pages first appear.
      const last = new Map<string, EventRow>();
      const first = new Map<string, number>();
      events.forEach((event, index) => {
        last.set(event.paper_id, event);
        if (!first.has(event.paper_id)) first.set(event.paper_id, index);
      });

      let failure: { index: number; error: string } | null = null;
      for (const [paperId, event] of last) {
        // A page whose repo is gone (deleted since) has nothing to bring up to date.
        if (event.head === null) continue;
        try {
          await consumer.handle(paperId, event.head, { database });
          report.pages += 1;
        } catch (err) {
          failure = { index: first.get(paperId)!, error: `page ${paperId} at ${event.head}: ${message(err)}` };
          break;
        }
      }

      // Every event before the failing page's first one belongs to a page already handled at a later head.
      const done = failure ? failure.index : events.length;
      const next = done > 0 ? { xid: events[done - 1].xid, id: events[done - 1].id } : position;
      const renewed = await moveCursor(database, consumer.name, token, next, failure?.error ?? null);
      if (!renewed) return { ...report, status: 'lease-lost' };
      token = renewed;
      position = next;
      report.events += done;
      if (failure) return { ...report, status: 'failed', error: failure.error };
      if (events.length < batchSize) return report;
    }
  } finally {
    await releaseLease(database, consumer.name, token).catch(() => {});
  }
}

/**
 * Starts a consumer over: clears what it holds (`reset`), then sets its cursor back to zero, so the worker
 * replays every event into it. Clearing the lease stops a worker that is running it at its next step.
 */
export async function rebuildConsumer(consumer: Consumer, database: Database = getDb()): Promise<void> {
  await consumer.reset?.({ database });
  await database.execute(sql`
    insert into consumer_cursors (name) values (${consumer.name})
    on conflict (name) do update
       set last_xid = '0', last_event_id = 0, leased_until = null, last_error = null, failed_at = null,
           updated_at = now()
  `);
}
