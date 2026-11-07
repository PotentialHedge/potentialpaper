import type { NextConfig } from 'next';
import { HOME_LIST_PARAMS, PRIVATE_PAGES } from './src/lib/private-paths';

const dev = process.env.NODE_ENV !== 'production';

/**
 * The content security policy, on every response. Scripts keep `'unsafe-inline'` because Next's inline
 * bootstrap scripts otherwise need a per-request nonce, and a nonce makes every page dynamic, which
 * rules out caching pages at the edge (DESIGN.md §2). Everything else is closed: scripts only from this
 * origin, inline and the analytics host, no frames, nothing fetched elsewhere but analytics, and no plugin, base or form tricks. User
 * content is sanitized when committed, so this is the second lock, not the first.
 */
// Page analytics (`lib/analytics.ts`): the tracker script and the beacons it sends back to its own origin.
const ANALYTICS = 'https://analytics.potentialhedge.com';

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${ANALYTICS}${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  `connect-src 'self' ${ANALYTICS}${dev ? ' ws:' : ''}`,
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js`: it tells a scanner which advisories to try.
  poweredByHeader: false,
  async redirects() {
    // A guessed address: there is no sign-up page of that name.
    return [
      { source: '/signup', destination: '/welcome', permanent: false },
      // Search moved to the home page. The query string carries over.
      { source: '/search', destination: '/', permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      ...PRIVATE_PAGES.map((source) => ({
        source,
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      })),
      ...HOME_LIST_PARAMS.map((key) => ({
        source: '/',
        has: [{ type: 'query' as const, key }],
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      })),
    ];
  },
  // Not optional: the production image copies .next/standalone and is far smaller than a full install.
  output: 'standalone',
};

export default nextConfig;
