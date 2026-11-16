import { and, asc, eq, like, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent, pages, venues } from '@/db/schema';
import { keyedPagePath, type VenueFile, venueFileSchema } from '@/lib/kinds';
import type { SubmissionStatus } from '@/lib/submissions';
import { type VenuePlace, venuePlace } from '@/lib/venues';
import { ensureBot } from './bots';
import { IMPORT_RATE_LIMIT } from './import-reviews';
import { type Actor, commitPage, createPage } from './pages/commit';
import type { PageRow } from './pages/kinds';
import { pageSummaries } from './plugins/pages';

/**
 * Venue pages (`handoffs/pages.md` Phase 2): the `venues` bot, which makes a series' and an edition's pages from the
 * venues the OpenReview import knows, and the reads a venue's page is made of: a series' editions, and an edition's
 * submissions by status.
 *
 * **The bot** (`npm run venues:sync`, and at the end of `papers:import-reviews`) is an account like any bot's, granted
 * `venue.json` on venue pages (migration `0035`). For each venue (`venues` rows, `<source>:<id>`) that is a conference's
 * main edition (`lib/venues.ts`), it makes the series page (`iclr`) and the edition page (`iclr/2027`), each with a
 * `venue.json`; the edition's lists the source, which is what makes the venue's submissions its members
 * (`page-members.ts`). It never takes anything away and never rewrites what someone else wrote: on a page whose
 * `venue.json` is there, it only adds a missing source. Its organisers and admins own the rest.
 *
 * **Score statistics** (`handoffs/plugins.md` Phase 4, `scope_stats`) aren't built yet; `venueScoreStats` is their
 * place, and the edition's page shows them once it returns something.
 */

export const VENUES_BOT = 'venues';

export interface VenueSyncReport {
  /** Pages made or whose `venue.json` the bot wrote, by key. */
  written: string[];
  /** Venues that map to no page yet (tracks, workshops, undated venues), by source id. */
  skipped: string[];
}

interface KnownVenue {
  id: string;
  name: string;
}

async function currentVenueFile(database: Database, pageId: string) {
  const [row] = await database
    .select({ head: pageCurrent.head, kindFile: pageCurrent.kindFile })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, pageId));
  return row ? { head: row.head.toString('hex'), kindFile: row.kindFile } : null;
}

/** What the bot writes into a page's `venue.json`: all of it on a new page, a missing source on one it finds. */
export function venueFileUpdate(existing: unknown, wanted: VenueFile): VenueFile | null {
  if (existing === null || existing === undefined) return wanted;
  const parsed = venueFileSchema.safeParse(existing);
  // Someone wrote a venue.json that doesn't parse; theirs to fix, not the bot's to overwrite.
  if (!parsed.success) return null;
  const sources = parsed.data.sources ?? [];
  const missing = (wanted.sources ?? []).filter((source) => !sources.includes(source));
  if (missing.length === 0) return null;
  return { ...parsed.data, sources: [...sources, ...missing] };
}

async function writeVenue(
  database: Database,
  bot: Actor,
  key: string,
  wanted: VenueFile,
  report: VenueSyncReport,
): Promise<PageRow> {
  const page = await createPage('venue', key, database);
  const current = await currentVenueFile(database, page.id);
  const next = venueFileUpdate(current?.kindFile ?? null, wanted);
  if (!next) return page;
  const result = await commitPage(
    page.id,
    current?.head ?? page.head,
    bot,
    [{ path: 'venue.json', content: `${JSON.stringify(next, null, 2)}\n` }],
    current?.kindFile ? `Add ${wanted.sources?.join(', ')} to ${key}` : `Start ${wanted.name}`,
    { database, rateLimit: IMPORT_RATE_LIMIT },
  );
  if (result.status === 'committed') report.written.push(key);
  return page;
}

/**
 * Makes the series and edition pages of the venues given, or of every venue the site knows. Idempotent: a second run
 * writes nothing.
 */
export async function syncVenuePages(
  options: { venues?: readonly KnownVenue[]; database?: Database } = {},
): Promise<VenueSyncReport> {
  const database = options.database ?? getDb();
  const known =
    options.venues ??
    (await database.select({ id: venues.id, name: venues.name }).from(venues).orderBy(asc(venues.id)));
  const report: VenueSyncReport = { written: [], skipped: [] };
  const places: VenuePlace[] = [];
  for (const venue of known) {
    const place = venuePlace(venue.id, venue.name);
    if (place) places.push(place);
    else report.skipped.push(venue.id);
  }
  if (places.length === 0) return report;
  const bot = await ensureBot(VENUES_BOT, database);
  const series = new Set<string>();
  for (const place of places) {
    if (!series.has(place.series.key)) {
      series.add(place.series.key);
      await writeVenue(database, bot, place.series.key, { name: place.series.name }, report);
    }
    await writeVenue(database, bot, place.edition.key, { name: place.edition.name, sources: [place.source] }, report);
  }
  return report;
}

/** An edition of a series, as the series' page lists it. */
export interface VenueEdition {
  pageId: string;
  key: string;
  name: string;
  dates: VenueFile['dates'] | null;
  /** Its submissions by status; `unknown` where the source didn't say. */
  counts: StatusCounts;
}

export type VenueStatus = SubmissionStatus | 'unknown';
export const VENUE_STATUSES: readonly VenueStatus[] = [
  'accepted',
  'under_review',
  'rejected',
  'desk_rejected',
  'withdrawn',
  'unknown',
];
export type StatusCounts = Partial<Record<VenueStatus, number>> & { total: number };

/** The venue pages one level under this one: a series' editions, newest first. */
export async function venueChildren(page: PageRow, database: Database = getDb()): Promise<VenueEdition[]> {
  const rows = await database
    .select({ pageId: pages.id, key: pages.key, name: pageCurrent.name, kindFile: pageCurrent.kindFile })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .where(and(eq(pages.kind, 'venue'), like(pages.key, `${page.key}/%`)))
    .orderBy(sql`${pages.key} desc`);
  const children = rows.filter((row) => !row.key.slice(page.key.length + 1).includes('/'));
  const counts = await statusCountsOf(
    children.map((c) => c.pageId),
    database,
  );
  return children.map((row) => ({
    pageId: row.pageId,
    key: row.key,
    name: row.name ?? row.key,
    dates: (row.kindFile as VenueFile | null)?.dates ?? null,
    counts: counts.get(row.pageId) ?? { total: 0 },
  }));
}

/** The venue page one level up (an edition's series) and its children (the series' editions), for the edition's line. */
export async function venueSiblings(page: PageRow, database: Database = getDb()) {
  const at = page.key.lastIndexOf('/');
  if (at <= 0) return null;
  const parentKey = page.key.slice(0, at);
  const [parent] = await database
    .select({ id: pages.id, kind: pages.kind, key: pages.key, name: pageCurrent.name })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .where(and(eq(pages.kind, 'venue'), eq(pages.key, parentKey)));
  if (!parent) return null;
  const editions = await venueChildren({ id: parent.id, kind: 'venue', key: parent.key }, database);
  return { parent: { key: parent.key, name: parent.name ?? parent.key }, editions };
}

/**
 * The submissions a scope's members made to it: each paper's submission to one of the venues the scope or a page under
 * it answers to (`page_scope_names`, its `venue.json` sources). `scopes` is a subquery of page ids.
 */
function scopeSubmissions(scopeIds: ReturnType<typeof sql>) {
  return sql`
    select distinct on (s.id) s.id, s.paper_id, s.status, s.decision, s.number, s.url, m.scope_page_id
      from page_members m
      join page_scope_names n on n.page_id = m.scope_page_id
      join submissions s on s.paper_id = m.paper_id and s.venue_id = n.name
     where m.via = 'submission' and m.scope_page_id in (${scopeIds})
  `;
}

/** The page and every page under it, as a subquery. */
function rolledUpIds(pageId: string) {
  return sql`select ${pageId}::uuid union select page_id from page_ancestors where ancestor_id = ${pageId}`;
}

/** Submissions by status for each page, rolled up. */
async function statusCountsOf(pageIds: readonly string[], database: Database): Promise<Map<string, StatusCounts>> {
  const out = new Map<string, StatusCounts>();
  for (const pageId of pageIds) out.set(pageId, await venueStatusCounts(pageId, database));
  return out;
}

/** A venue's submissions by status, rolled up from the venues under it. */
export async function venueStatusCounts(pageId: string, database: Database = getDb()): Promise<StatusCounts> {
  const { rows } = await database.execute<{ status: string | null; n: number }>(sql`
    select status, count(*)::int as n from (${scopeSubmissions(rolledUpIds(pageId))}) sub group by status
  `);
  const counts: StatusCounts = { total: 0 };
  for (const row of rows) {
    const status = (row.status ?? 'unknown') as VenueStatus;
    counts[status] = (counts[status] ?? 0) + row.n;
    counts.total += row.n;
  }
  return counts;
}

export interface VenuePaperFilter {
  status?: VenueStatus;
  /** The decision as the venue words it: "Accept (Oral)". */
  decision?: string;
  /** Words in the title. */
  q?: string;
  offset?: number;
  limit?: number;
}

export interface VenuePaper {
  paperId: string;
  title: string;
  status: VenueStatus;
  decision: string | null;
  number: number | null;
  /** The submission at the source: OpenReview's forum. */
  url: string | null;
  /** The venue page it was submitted to, when it's under this one: an edition on a series' page. */
  venue: { key: string; name: string } | null;
}

export interface VenuePapers {
  total: number;
  papers: VenuePaper[];
  nextOffset: number | null;
}

const STATUS_RANK = sql.raw(
  `case coalesce(sub.status, 'unknown') ${VENUE_STATUSES.map((s, i) => `when '${s}' then ${i}`).join(' ')} end`,
);

function filterSql(filter: VenuePaperFilter) {
  const parts = [sql`true`];
  if (filter.status === 'unknown') parts.push(sql`sub.status is null`);
  else if (filter.status) parts.push(sql`sub.status = ${filter.status}`);
  if (filter.decision) parts.push(sql`sub.decision = ${filter.decision}`);
  const q = filter.q?.trim();
  if (q) parts.push(sql`p.title ilike ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);
  return sql.join(parts, sql` and `);
}

/**
 * A venue's submissions, rolled up from the venues under it, filtered by status, decision and title, accepted first,
 * then by their number at the venue. A paper submitted to two editions of a series is listed under each.
 */
export async function venuePapers(
  pageId: string,
  filter: VenuePaperFilter = {},
  database: Database = getDb(),
): Promise<VenuePapers> {
  const { offset = 0, limit = 50 } = filter;
  const where = filterSql(filter);
  const from = sql`(${scopeSubmissions(rolledUpIds(pageId))}) sub join papers p on p.id = sub.paper_id`;
  const [{ rows: totals }, { rows }] = await Promise.all([
    database.execute<{ n: number }>(sql`select count(*)::int as n from ${from} where ${where}`),
    database.execute<{
      paper_id: string;
      title: string;
      status: SubmissionStatus | null;
      decision: string | null;
      number: number | null;
      url: string | null;
      scope_key: string;
      scope_name: string | null;
      scope_page_id: string;
    }>(sql`
      select sub.paper_id, p.title, sub.status, sub.decision, sub.number, sub.url, sub.scope_page_id,
             sp.key as scope_key, c.name as scope_name
        from ${from}
        join pages sp on sp.id = sub.scope_page_id
        left join page_current c on c.page_id = sub.scope_page_id
       where ${where}
       order by ${STATUS_RANK}, sub.number nulls last, p.title, sub.id
       limit ${limit} offset ${offset}
    `),
  ]);
  const total = totals[0]?.n ?? 0;
  const next = offset + rows.length;
  return {
    total,
    papers: rows.map((row) => ({
      paperId: row.paper_id,
      title: row.title,
      status: row.status ?? 'unknown',
      decision: row.decision,
      number: row.number,
      url: row.url,
      venue: row.scope_page_id === pageId ? null : { key: row.scope_key, name: row.scope_name ?? row.scope_key },
    })),
    nextOffset: rows.length === limit && next < total ? next : null,
  };
}

/** The decisions a venue's submissions have, as the venue words them, with how many have each, most first. */
export async function venueDecisions(
  pageId: string,
  database: Database = getDb(),
): Promise<{ decision: string; count: number }[]> {
  const { rows } = await database.execute<{ decision: string; n: number }>(sql`
    select decision, count(*)::int as n from (${scopeSubmissions(rolledUpIds(pageId))}) sub
     where decision is not null group by decision order by n desc, decision limit 30
  `);
  return rows.map((row) => ({ decision: row.decision, count: row.n }));
}

/**
 * A venue's score statistics: per score field, its submissions' means, bins and the split by status
 * (`handoffs/plugins.md` Phase 4's `scope_stats`). Not built yet; until it is, there are none and the page shows no
 * panel for them. When `scope_stats` lands, read it here and add a `scores` panel to `lib/panels.ts`' venue slots.
 */
export async function venueScoreStats(pageId: string): Promise<null> {
  void pageId;
  return null;
}

export function isVenueStatus(value: string): value is VenueStatus {
  return (VENUE_STATUSES as readonly string[]).includes(value);
}

/** A venue's submissions as the page and `GET /pages/{identifier}/venue-papers` give them: by public identifier. */
export interface PresentedVenuePapers {
  total: number;
  papers: {
    title: string;
    identifier: string | null;
    address: string | null;
    status: VenueStatus;
    decision: string | null;
    number: number | null;
    url: string | null;
    venue: { identifier: string; address: string; name: string } | null;
  }[];
  nextOffset: number | null;
}

export async function presentVenuePapers(
  pageId: string,
  filter: VenuePaperFilter = {},
  database: Database = getDb(),
): Promise<PresentedVenuePapers> {
  const found = await venuePapers(pageId, filter, database);
  const summaries = await pageSummaries(
    found.papers.map((p) => p.paperId),
    database,
  );
  return {
    total: found.total,
    nextOffset: found.nextOffset,
    papers: found.papers.map(({ paperId, venue, ...paper }) => {
      const summary = summaries.get(paperId);
      return {
        ...paper,
        identifier: summary?.identifier ?? null,
        address: summary?.address ?? null,
        venue: venue
          ? { identifier: `venue:${venue.key}`, address: keyedPagePath('venue', venue.key), name: venue.name }
          : null,
      };
    }),
  };
}
