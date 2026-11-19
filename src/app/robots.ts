import type { MetadataRoute } from 'next';
import { PRIVATE_PAGES } from '@/lib/private-paths';
import { siteUrl } from '@/server/site';

/** Public pages are open to crawlers and AI agents alike; the private pages, the API and the git clone addresses are not. */
// `siteUrl()` is read per request: the image build has no environment.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/git/', '/edit/', '/code/', '/editor/', '/claim/', '/?', ...PRIVATE_PAGES],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
