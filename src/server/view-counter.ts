import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { ipNetwork } from '@/lib/ip-network';

/**
 * Unique viewers per day of a paper, as acceptodds counts a listing's.
 *
 * A visitor is a signed-in account, or else a network: the client's IPv4 address, or its IPv6 /64
 * (`lib/ip-network.ts`), from `Cf-Connecting-Ip` via `clientIp()`, so it is the real client behind Cloudflare.
 * Never the user agent, which the client chooses: with it in, one machine was as many visitors as it cared to
 * name. So anonymous readers behind one NAT count once; signed-in ones count each. What is stored is an HMAC of
 * the day and that identity under the server secret: no address or account id, and as the day is inside the hash
 * one day's visitor cannot be linked to the next. The same visitor on the same day is one row (the primary key),
 * and `papers.view_count` goes up only when the row is new, in one statement.
 *
 * Counted by a beacon from the browser (`components/paper/ViewCount.tsx`), not on render: a paper's page is
 * served from the cache and never reaches the origin, and a crawler that runs no script is not a viewer.
 */

/** Who is viewing: the account when there is one, else the client's network. */
export interface Viewer {
  accountId?: string | null;
  ip: string | null;
}

function who(viewer: Viewer): string {
  return viewer.accountId ? `account:${viewer.accountId}` : `net:${ipNetwork(viewer.ip) ?? ''}`;
}

export function visitorHash(day: string, viewer: Viewer): string {
  return createHmac('sha256', process.env.BETTER_AUTH_SECRET ?? '')
    .update(`view\0${day}\0${who(viewer)}`)
    .digest('hex');
}

/** A date in UTC, as `YYYY-MM-DD`. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Count the visitor as having viewed the paper today. Returns the paper's total views after, or `null` when the
 * paper does not exist.
 */
export async function countView(
  paperId: string,
  viewer: Viewer,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<number | null> {
  const day = utcDay(now);
  const visitor = visitorHash(day, viewer);
  const result = await database.execute<{ view_count: number }>(sql`
    with found as (select view_count from papers where id = ${paperId}::uuid),
    ins as (
      insert into paper_views (paper_id, day, visitor)
      select ${paperId}::uuid, ${day}::date, ${visitor} from found
      on conflict do nothing
      returning 1
    ),
    bump as (
      update papers set view_count = view_count + 1
      where id = ${paperId}::uuid and exists (select 1 from ins)
      returning view_count
    )
    select coalesce((select view_count from bump), (select view_count from found)) as view_count
      from found
  `);
  // Old rows only exist to dedupe today: sweep now and then, not on every view.
  if (Math.random() < 0.01) {
    await database.execute(
      sql`delete from paper_views where day < ${utcDay(new Date(now.getTime() - 86_400_000))}::date`,
    );
  }
  const row = result.rows[0];
  return row ? Number(row.view_count) : null;
}
