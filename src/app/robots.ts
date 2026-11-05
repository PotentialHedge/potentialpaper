import type { MetadataRoute } from 'next';
import { PRIVATE_PAGES } from '@/lib/private-paths';

/** Public pages are open to crawlers and AI agents alike; the private pages and the API are not. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', ...PRIVATE_PAGES] }] };
}
