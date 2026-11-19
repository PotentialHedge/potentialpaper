import { FIXED_PATHS, keyedPaths, paperPaths, paperSitemapCount, sitemapXml } from '@/server/seo';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/** `/sitemaps/<n>.xml`, listed by `/sitemap.xml`: 0 is the fixed pages and every page but papers, 1… the papers. */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const match = /^(\d{1,4})\.xml$/.exec((await params).file);
  if (!match) return new Response('Not found\n', { status: 404 });
  const n = Number(match[1]);
  const origin = siteUrl();
  if (n === 0) {
    const paths = [...FIXED_PATHS, ...(await keyedPaths())];
    return sitemapXml(
      'urlset',
      paths.map((p) => `${origin}${p === '/' ? '' : p}`),
    );
  }
  if (n > (await paperSitemapCount())) return new Response('Not found\n', { status: 404 });
  return sitemapXml(
    'urlset',
    (await paperPaths(n - 1)).map((p) => `${origin}${p}`),
  );
}
