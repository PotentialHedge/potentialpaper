import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { ipNetwork } from '@/lib/ip-network';
import { pageSummaries } from './plugins/pages';

/**
 * Unique viewers per day of a page of any kind, as acceptodds counts a listing's. A paper's page id is the paper's
 * id, so one counter covers papers, venues, categories, orgs and people.
 *
 * A visitor is a signed-in account, or else a network: the client's IPv4 address, or its IPv6 /64
 * (`lib/ip-network.ts`), from `Cf-Connecting-Ip` via `clientIp()`, so it is the real client behind Cloudflare.
 * Never the user agent, which the client chooses: with it in, one machine was as many visitors as it cared to
 * name. So anonymous readers behind one NAT count once; signed-in ones count each. What is stored is an HMAC of
 * the day and that identity under the server secret: no address or account id, and as the day is inside the hash
 * one day's visitor cannot be linked to the next. The same visitor on the same day is one row (the primary key),
 * and `pages.view_count` goes up only when the row is new, in one statement.
 *
 * Counted by a beacon from the browser (`components/ViewCount.tsx`), not on render: a page is served from the cache
 * and never reaches the origin, and a crawler that runs no script is not a viewer.
 *
 * The same beacon may name the page the visitor read just before (`countTransition`): counted the same way, per
 * ordered pair, and kept only as a total per pair. That is what "readers of this also read" is built from.
 */

/** Who is viewing: the account when there is one, else the client's network. */
/** Below this many viewers a page's count is not shown: a handful reads as neglect, not information (as acceptodds). */
export const MIN_SHOWN_VIEWS = 10;

export interface Viewer {
  accountId?: string | null;
  ip: string | null;
}

export function who(viewer: Viewer): string {
  return viewer.accountId ? `account:${viewer.accountId}` : `net:${ipNetwork(viewer.ip) ?? ''}`;
}

export function hmacOf(message: string): string {
  return createHmac('sha256', process.env.BETTER_AUTH_SECRET ?? '')
    .update(message)
    .digest('hex');
}

export function visitorHash(day: string, viewer: Viewer): string {
  return hmacOf(`view\0${day}\0${who(viewer)}`);
}

/** The pair is inside the hash, so a row joins neither to a view nor to the visitor's other pairs. */
export function transitionHash(day: string, viewer: Viewer, fromPageId: string, toPageId: string): string {
  return hmacOf(`transition\0${day}\0${who(viewer)}\0${fromPageId}\0${toPageId}`);
}

/** A date in UTC, as `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function yesterday(now: Date): string {
  return utcDay(new Date(now.getTime() - 86_400_000));
}

/**
 * Count the visitor as having viewed the page today. Returns the page's total views after, or `null` when the page
 * does not exist.
 */
export async function countView(
  pageId: string,
  viewer: Viewer,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<number | null> {
  const day = utcDay(now);
  const visitor = visitorHash(day, viewer);
  const result = await database.execute<{ view_count: number }>(sql`
    with found as (select view_count from pages where id = ${pageId}::uuid),
    ins as (
      insert into page_views (page_id, day, visitor)
      select ${pageId}::uuid, ${day}::date, ${visitor} from found
      on conflict do nothing
      returning 1
    ),
    bump as (
      update pages set view_count = view_count + 1
      where id = ${pageId}::uuid and exists (select 1 from ins)
      returning view_count
    ),
    -- The same visitor, by day, for its owners analytics (page-analytics.ts).
    daily as (
      insert into page_daily_counts (page_id, day, metric, count)
      select ${pageId}::uuid, ${day}::date, 'views', 1 from ins
      on conflict (page_id, day, metric) do update set count = page_daily_counts.count + 1
    )
    select coalesce((select view_count from bump), (select view_count from found)) as view_count
      from found
  `);
  // Old rows only exist to dedupe today: sweep now and then, not on every view.
  if (Math.random() < 0.01) {
    await database.execute(sql`delete from page_views where day < ${yesterday(now)}::date`);
  }
  const row = result.rows[0];
  return row ? Number(row.view_count) : null;
}

/**
 * Count the visitor as having read `toPageId` after `fromPageId` today: once a day per visitor and ordered pair,
 * summed into `page_transitions`. Nothing is counted for a page to itself or from a page that does not exist.
 * Returns whether the count went up.
 */
export async function countTransition(
  fromPageId: string,
  toPageId: string,
  viewer: Viewer,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<boolean> {
  if (fromPageId === toPageId) return false;
  const day = utcDay(now);
  const visitor = transitionHash(day, viewer, fromPageId, toPageId);
  const result = await database.execute(sql`
    with ins as (
      insert into page_transition_visits (day, visitor)
      select ${day}::date, ${visitor}
       where exists (select 1 from pages where id = ${fromPageId}::uuid)
         and exists (select 1 from pages where id = ${toPageId}::uuid)
      on conflict do nothing
      returning 1
    )
    insert into page_transitions (from_page_id, to_page_id, count)
    select ${fromPageId}::uuid, ${toPageId}::uuid, 1 from ins
    on conflict (from_page_id, to_page_id) do update set count = page_transitions.count + 1
    returning 1
  `);
  if (Math.random() < 0.01) {
    await database.execute(sql`delete from page_transition_visits where day < ${yesterday(now)}::date`);
  }
  return result.rows.length > 0;
}

/**
 * Every ordered pair of pages read one after the other at least `min` times, most first, by page identifier
 * (`arxiv:…`, `venue:iclr/2027`). Pages with no address (a paper with no identifier) are left out.
 */
export async function transitionCounts(
  min: number,
  database: Database = getDb(),
): Promise<{ from: string; to: string; count: number }[]> {
  const result = await database.execute<{ from: string; to: string; count: number }>(sql`
    select from_page_id as "from", to_page_id as "to", count
      from page_transitions
     where count >= ${min}
     order by count desc, from_page_id, to_page_id
  `);
  const ids = result.rows.flatMap((r) => [r.from, r.to]);
  const summaries = await pageSummaries(ids, database);
  return result.rows.flatMap((r) => {
    const from = summaries.get(r.from);
    const to = summaries.get(r.to);
    return from && to ? [{ from: from.identifier, to: to.identifier, count: Number(r.count) }] : [];
  });
}
