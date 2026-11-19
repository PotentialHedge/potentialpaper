import { paperSitemapCount, sitemapXml } from '@/server/seo';
import { siteUrl } from '@/server/site';

// Read from the database per request, never at build time.
export const dynamic = 'force-dynamic';

/** `/sitemap.xml`: the index of the sitemaps, `/sitemaps/0.xml` (fixed pages and every page but papers) and one per 40,000 papers. */
export async function GET() {
  const origin = siteUrl();
  const count = await paperSitemapCount();
  return sitemapXml(
    'sitemapindex',
    Array.from({ length: count + 1 }, (_, i) => `${origin}/sitemaps/${i}.xml`),
  );
}
