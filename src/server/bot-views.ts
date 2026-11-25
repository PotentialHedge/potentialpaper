import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { type BotSource, botSource } from '@/lib/bot-sources';
import { KINDS, PAGE_KINDS } from '@/lib/kinds';
import { PATH_PREFIX } from '@/lib/paper-ids';
import { findPage } from './pages/kinds';
import { shareSubject } from './share';

/**
 * Bots' and crawlers' reads of each page, per UTC day, from Cloudflare's request log (its GraphQL Analytics API,
 * `httpRequestsAdaptiveGroups`), which sees the requests its cache answers too: our own counters never do, and most
 * bots run no script for the browser's beacon (`view-counter.ts`). Kept per kind of bot (`lib/bot-sources.ts`) as the
 * `bots:<source>` metrics in `page_daily_counts`, set rather than added to, so pulling a day again replaces them. A bot is a client that says it is one in its user
 * agent; one that pretends to be a browser counts as nothing here. Cloudflare samples busy hours, so the counts are
 * estimates. Pulled daily (`scripts/bot-views.ts`); Cloudflare keeps 31 days on our plan.
 */

/** User agents that say they are a bot: `*bot*`, crawlers, spiders, and AI assistants fetching for a person. */
const BOT_AGENTS = ['%bot%', '%Bot%', '%BOT%', '%rawler%', '%pider%', '%-User/%', 'facebookexternalhit%'];

/** The paths a page is read at: its own, and a paper's page for AI agents (`/agent/s/<n>`). */
const PAGE_ROUTES = [
  '/s/',
  '/agent/',
  ...Object.values(PATH_PREFIX).map((p) => `${p}/`),
  ...PAGE_KINDS.filter((k) => k !== 'paper').map((k) => `${KINDS[k].route}/`),
];

/** Cloudflare's most rows in one answer; a window that fills it is split. */
const LIMIT = 10_000;

interface Window {
  from: Date;
  to: Date;
}

async function query(
  token: string,
  zone: string,
  window: Window,
): Promise<{ path: string; userAgent: string; count: number }[]> {
  const filter = {
    datetime_geq: window.from.toISOString(),
    datetime_lt: window.to.toISOString(),
    requestSource: 'eyeball',
    clientRequestHTTPMethodName: 'GET',
    edgeResponseStatus_in: [200, 304],
    AND: [
      { OR: BOT_AGENTS.map((ua) => ({ userAgent_like: ua })) },
      { OR: PAGE_ROUTES.map((route) => ({ clientRequestPath_like: `${route}%` })) },
    ],
  };
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query ($zone: string!, $filter: ZoneHttpRequestsAdaptiveGroupsFilter_InputObject!) {
        viewer { zones(filter: { zoneTag: $zone }) {
          httpRequestsAdaptiveGroups(limit: ${LIMIT}, filter: $filter) { count dimensions { clientRequestPath userAgent } }
        } }
      }`,
      variables: { zone, filter },
    }),
  });
  if (!res.ok) throw new Error(`Cloudflare analytics: HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      viewer: {
        zones: {
          httpRequestsAdaptiveGroups: { count: number; dimensions: { clientRequestPath: string; userAgent: string } }[];
        }[];
      };
    };
    errors?: { message: string }[] | null;
  };
  if (body.errors?.length) throw new Error(`Cloudflare analytics: ${body.errors.map((e) => e.message).join('; ')}`);
  const groups = body.data?.viewer.zones[0]?.httpRequestsAdaptiveGroups ?? [];
  return groups.map((g) => ({
    path: g.dimensions.clientRequestPath,
    userAgent: g.dimensions.userAgent,
    count: g.count,
  }));
}

/** Bots' requests per path and kind of bot (`<source>\0<path>`) over a window, split in halves while one answer would be cut off. */
async function hits(token: string, zone: string, window: Window, into: Map<string, number>): Promise<void> {
  const rows = await query(token, zone, window);
  const span = window.to.getTime() - window.from.getTime();
  if (rows.length >= LIMIT && span > 60_000) {
    const mid = new Date(window.from.getTime() + Math.floor(span / 2 / 1000) * 1000);
    await hits(token, zone, { from: window.from, to: mid }, into);
    await hits(token, zone, { from: mid, to: window.to }, into);
    return;
  }
  for (const { path, userAgent, count } of rows) {
    const key = `${botSource(userAgent)}\0${path}`;
    into.set(key, (into.get(key) ?? 0) + count);
  }
}

/** The identifier a page path names (`/v/iclr/2027` → `venue:iclr/2027`); a short one by its number. */
function identifierOfPath(path: string): { short: string } | { identifier: string } | null {
  const rest = path.replace(/^\/agent(?=\/)/, '').replace(/\/+$/, '');
  const short = /^\/s\/(\d{1,9})$/.exec(rest);
  if (short) return { short: short[1] };
  const at = rest.indexOf('/', 1);
  if (at < 0) return null;
  const route = rest.slice(0, at);
  let value: string;
  try {
    value = decodeURIComponent(rest.slice(at + 1));
  } catch {
    return null;
  }
  if (!value) return null;
  for (const [scheme, prefix] of Object.entries(PATH_PREFIX)) {
    if (prefix === route) return { identifier: `${scheme}:${value}` };
  }
  const kind = PAGE_KINDS.find((k) => k !== 'paper' && KINDS[k].route === route);
  return kind ? { identifier: `${kind}:${value}` } : null;
}

async function pageIdOfPath(path: string, database: Database): Promise<string | null> {
  const named = identifierOfPath(path);
  if (!named) return null;
  if ('short' in named) return (await shareSubject(named.short, database))?.pageId ?? null;
  return (await findPage(named.identifier, database))?.id ?? null;
}

/**
 * Pull one UTC day's bot reads from Cloudflare and keep them per page, replacing what that day had. Returns how many
 * requests were counted and on how many pages.
 */
export async function pullBotViews(
  day: string,
  { token, zone }: { token: string; zone: string },
  database: Database = getDb(),
): Promise<{ requests: number; pages: number }> {
  const from = new Date(`${day}T00:00:00Z`);
  const to = new Date(Math.min(from.getTime() + 86_400_000, Date.now()));
  const byPath = new Map<string, number>();
  await hits(token, zone, { from, to }, byPath);

  const pageIds = new Map<string, string | null>();
  const byPage = new Map<string, number>();
  for (const [key, count] of byPath) {
    const [source, path] = key.split('\0') as [BotSource, string];
    if (!pageIds.has(path)) pageIds.set(path, await pageIdOfPath(path, database));
    const pageId = pageIds.get(path);
    if (pageId) byPage.set(`${pageId}\0${source}`, (byPage.get(`${pageId}\0${source}`) ?? 0) + count);
  }
  const rows = [...byPage].map(([key, count]) => {
    const [pageId, source] = key.split('\0');
    return { page_id: pageId, metric: `bots:${source}`, count };
  });
  await database.transaction(async (tx) => {
    await tx.execute(sql`delete from page_daily_counts where day = ${day}::date and metric like 'bots%'`);
    for (let i = 0; i < rows.length; i += 1000) {
      await tx.execute(sql`
        insert into page_daily_counts (page_id, day, metric, count)
        select r.page_id, ${day}::date, r.metric, r.count
          from jsonb_to_recordset(${JSON.stringify(rows.slice(i, i + 1000))}::jsonb)
               as r(page_id uuid, metric text, count int)
         where exists (select 1 from pages where id = r.page_id)
      `);
    }
  });
  return { requests: rows.reduce((sum, r) => sum + r.count, 0), pages: new Set(rows.map((r) => r.page_id)).size };
}
