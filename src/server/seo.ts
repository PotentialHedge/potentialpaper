import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { isPageKind, keyedPagePath } from '@/lib/kinds';

/**
 * What the sitemaps read (`app/sitemap.xml`, `app/sitemaps/[file]`): the public pages' addresses. **Reads only.**
 * Sitemap 0 is the fixed pages and every page that isn't a paper; papers follow, {@link PAPERS_PER_SITEMAP} to a
 * file, at their canonical address. A sitemap may hold 50,000 addresses.
 */

export const PAPERS_PER_SITEMAP = 40_000;
const MAX_KEYED = 45_000;

/** The pages that are always there. */
export const FIXED_PATHS = ['/', '/about', '/privacy', '/docs'];

/** How many paper sitemaps there are: papers that are not merged into another and have an address. */
export async function paperSitemapCount(database: Database = getDb()): Promise<number> {
  const { rows } = await database.execute<{ n: number }>(sql`
    select count(*)::int as n from papers p
    where p.merged_into is null and exists (select 1 from paper_identifiers i where i.paper_id = p.id)`);
  return Math.ceil((rows[0]?.n ?? 0) / PAPERS_PER_SITEMAP);
}

/** The `index`th file of papers (0-based), each at its address, `/s/<n>`. */
export async function paperPaths(index: number, database: Database = getDb()): Promise<string[]> {
  const { rows } = await database.execute<{ short_id: number }>(sql`
    select pg.short_id from papers p join pages pg on pg.id = p.id
    where p.merged_into is null and exists (select 1 from paper_identifiers i where i.paper_id = p.id)
    order by p.id
    offset ${index * PAPERS_PER_SITEMAP} limit ${PAPERS_PER_SITEMAP}`);
  return rows.map((r) => `/s/${r.short_id}`);
}

/** Every venue, category, organisation and person's page that isn't merged into another. */
export async function keyedPaths(database: Database = getDb()): Promise<string[]> {
  const { rows } = await database.execute<{ kind: string; key: string }>(sql`
    select kind, key from pages
    where kind <> 'paper' and merged_into is null
    order by kind, key
    limit ${MAX_KEYED}`);
  return rows.flatMap((r) => (isPageKind(r.kind) && r.kind !== 'paper' ? [keyedPagePath(r.kind, r.key)] : []));
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A response of sitemap XML; `tag` is `url` in a sitemap and `sitemap` in an index. */
export function sitemapXml(root: 'urlset' | 'sitemapindex', urls: string[]): Response {
  const tag = root === 'urlset' ? 'url' : 'sitemap';
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<${tag}><loc>${escape(u)}</loc></${tag}>`).join('\n')}
</${root}>
`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}
