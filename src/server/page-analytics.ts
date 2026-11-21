import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageSummaries } from './plugins/pages';
import { hmacOf, type Viewer, who } from './view-counter';

/**
 * A page's analytics, for its owners only (DESIGN.md §5.3): unique visitors, git clones and pulls, agent reads and
 * time on the page, per UTC day (`page_daily_counts`); visitors' institutions per month (`page_institution_counts`),
 * shown only where enough people came from one that none of them can be told apart; and which pages its readers
 * read before and after it (`page_transitions`). Every count is deduplicated as `view-counter.ts` counts views: an
 * HMAC of the day (or month) and the visitor in `page_views`, never who.
 */

/** An institution is shown only once this many of its people read the page in one month. */
export const MIN_INSTITUTION_VISITORS = 5;

/** How long a visitor kept the page open, in buckets by their upper bound in seconds; the last has none. */
export const TIME_BUCKETS = [
  { max: 10, label: 'under 10 s' },
  { max: 30, label: '10–30 s' },
  { max: 60, label: '30 s–1 min' },
  { max: 120, label: '1–2 min' },
  { max: 300, label: '2–5 min' },
  { max: 600, label: '5–10 min' },
  { max: Infinity, label: 'over 10 min' },
] as const;

/** How many days the graphs cover. */
export const ANALYTICS_DAYS = 90;
/** How many months institutions are summed over. */
const INSTITUTION_MONTHS = 12;

export type Metric = 'views' | 'git' | 'agent';

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function utcMonth(at: Date, back = 0): string {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - back, 1)).toISOString().slice(0, 10);
}

export function timeBucket(seconds: number): number {
  return TIME_BUCKETS.findIndex((b) => seconds < b.max);
}

/**
 * Count the visitor once today under `key` (its own namespace in `page_views`), adding one to the page's `metric`
 * for the day when they are new. Returns whether they were. Nothing is counted for a page that doesn't exist.
 */
export async function countDaily(
  pageId: string,
  key: string,
  metric: string,
  viewer: Viewer,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<boolean> {
  const day = utcDay(now);
  const visitor = hmacOf(`${key}\0${day}\0${who(viewer)}`);
  const result = await database.execute(sql`
    with ins as (
      insert into page_views (page_id, day, visitor)
      select ${pageId}::uuid, ${day}::date, ${visitor}
       where exists (select 1 from pages where id = ${pageId}::uuid)
      on conflict do nothing
      returning 1
    )
    insert into page_daily_counts (page_id, day, metric, count)
    select ${pageId}::uuid, ${day}::date, ${metric}, 1 from ins
    on conflict (page_id, day, metric) do update set count = page_daily_counts.count + 1
    returning 1
  `);
  return result.rows.length > 0;
}

/** As `countDaily`, but never failing what it is counted for: git, an agent's read. */
export function countQuietly(pageId: string, metric: Metric, viewer: Viewer): void {
  countDaily(pageId, metric, metric, viewer).catch((err) => console.error(`analytics: counting ${metric}`, err));
}

/** How long a visitor kept the page open: their first report of the day counts. */
export async function countTime(pageId: string, seconds: number, viewer: Viewer, now = new Date()): Promise<boolean> {
  return countDaily(pageId, 'time', `time:${timeBucket(seconds)}`, viewer, now);
}

/**
 * Count a signed-in visitor's institution (their first confirmed one) for the page this month, once a month. A bot,
 * or an account with no institution, counts nothing.
 */
export async function countInstitution(
  pageId: string,
  accountId: string,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<void> {
  const month = utcMonth(now);
  const visitor = hmacOf(`institution\0${month}\0account:${accountId}\0${pageId}`);
  await database.execute(sql`
    with acct as (
      select institutions[1] as institution from accounts
       where id = ${accountId}::uuid and not is_bot and cardinality(institutions) > 0
    ),
    ins as (
      insert into page_month_visitors (month, visitor)
      select ${month}::date, ${visitor} from acct
      on conflict do nothing
      returning 1
    )
    insert into page_institution_counts (page_id, month, institution, visitors)
    select ${pageId}::uuid, ${month}::date, institution, 1 from acct where exists (select 1 from ins)
    on conflict (page_id, month, institution) do update set visitors = page_institution_counts.visitors + 1
  `);
  if (Math.random() < 0.01) {
    await database.execute(sql`delete from page_month_visitors where month < ${utcMonth(now, 1)}::date`);
  }
}

export interface PageAnalytics {
  /** The last `ANALYTICS_DAYS` days, oldest first, every day there even with nothing. */
  days: { day: string; views: number; git: number; agent: number }[];
  /** Unique visitors since the page began counting. */
  totalViews: number;
  /** Visitors by how long they kept the page open, over the same days, as `TIME_BUCKETS`. */
  time: number[];
  /** Over the last twelve months: only institutions with `MIN_INSTITUTION_VISITORS` in a month, those months summed. */
  institutions: { name: string; visitors: number }[];
  /** Pages readers read right after this one, and right before, most first. */
  next: { name: string; address: string; count: number }[];
  previous: { name: string; address: string; count: number }[];
}

const RELATED = 10;

export async function pageAnalytics(
  pageId: string,
  now: Date = new Date(),
  database: Database = getDb(),
): Promise<PageAnalytics> {
  const today = utcDay(now);
  const first = utcDay(new Date(now.getTime() - (ANALYTICS_DAYS - 1) * 86_400_000));
  const [counts, total, institutions, next, previous] = await Promise.all([
    database.execute<{ day: string; metric: string; count: number }>(sql`
      select day::text as day, metric, count from page_daily_counts
       where page_id = ${pageId}::uuid and day between ${first}::date and ${today}::date
    `),
    database.execute<{ view_count: number }>(sql`select view_count from pages where id = ${pageId}::uuid`),
    database.execute<{ name: string; visitors: number }>(sql`
      select institution as name, sum(visitors)::int as visitors from page_institution_counts
       where page_id = ${pageId}::uuid and month >= ${utcMonth(now, INSTITUTION_MONTHS - 1)}::date
         and visitors >= ${MIN_INSTITUTION_VISITORS}
       group by institution order by visitors desc, institution
    `),
    database.execute<{ id: string; count: number }>(sql`
      select to_page_id as id, count from page_transitions
       where from_page_id = ${pageId}::uuid order by count desc limit ${RELATED * 2}
    `),
    database.execute<{ id: string; count: number }>(sql`
      select from_page_id as id, count from page_transitions
       where to_page_id = ${pageId}::uuid order by count desc limit ${RELATED * 2}
    `),
  ]);

  const byDay = new Map<string, PageAnalytics['days'][number]>();
  for (let i = ANALYTICS_DAYS - 1; i >= 0; i -= 1) {
    const day = utcDay(new Date(now.getTime() - i * 86_400_000));
    byDay.set(day, { day, views: 0, git: 0, agent: 0 });
  }
  const time = TIME_BUCKETS.map(() => 0);
  for (const row of counts.rows) {
    const entry = byDay.get(row.day);
    const n = Number(row.count);
    if (row.metric.startsWith('time:')) time[Number(row.metric.slice(5))] += n;
    else if (entry && (row.metric === 'views' || row.metric === 'git' || row.metric === 'agent'))
      entry[row.metric] += n;
  }

  const summaries = await pageSummaries(
    [...next.rows, ...previous.rows].map((r) => r.id),
    database,
  );
  const related = (rows: { id: string; count: number }[]) =>
    rows
      .flatMap((r) => {
        const s = summaries.get(r.id);
        return s ? [{ name: s.name, address: s.address, count: Number(r.count) }] : [];
      })
      .slice(0, RELATED);

  return {
    days: [...byDay.values()],
    totalViews: Number(total.rows[0]?.view_count ?? 0),
    time,
    institutions: institutions.rows.map((r) => ({ name: r.name, visitors: Number(r.visitors) })),
    next: related(next.rows),
    previous: related(previous.rows),
  };
}
