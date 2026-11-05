import type { MetadataRoute } from 'next';
import { PRIVATE_PAGES } from '@/lib/private-paths';

/** Public pages are open to crawlers and AI agents alike; the private pages, the API and the git clone addresses are not. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', '/git/', ...PRIVATE_PAGES] }] };
}
