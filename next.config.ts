import type { NextConfig } from 'next';
import { editorCsp } from './src/editors/vscode/csp';
import { DEMO_HOSTNAME, DEMO_ORIGIN } from './src/lib/demos';
import { HOME_LIST_PARAMS, PRIVATE_PAGES } from './src/lib/private-paths';

const dev = process.env.NODE_ENV !== 'production';

/**
 * The content security policy, on every response. Scripts keep `'unsafe-inline'` because Next's inline
 * bootstrap scripts otherwise need a per-request nonce, and a nonce makes every page dynamic, which
 * rules out caching pages at the edge (DESIGN.md §2). Everything else is closed: scripts only from this
 * origin, inline and the analytics host, frames only from the demo host, nothing fetched elsewhere but analytics, and no plugin, base or form tricks. User
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
  // Demos, which run on a host of their own (`lib/demos.ts`), and the web editor's frame (`app/code`).
  `frame-src 'self' ${DEMO_ORIGIN}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js`: it tells a scanner which advisories to try.
  poweredByHeader: false,
  // A demo's folder needs its slash, or its relative addresses resolve one level up. `proxy.ts` removes the
  // slash on the app's own host, as Next would.
  skipTrailingSlashRedirect: true,
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
        // Everything but the web editor, which has a policy of its own (`src/editors/vscode/csp.ts`).
        source: '/:path((?!editor/).*)',
        // The demo host sends its own headers (`server/demos/serve.ts`).
        missing: [{ type: 'host' as const, value: DEMO_HOSTNAME.replaceAll('.', '\\.') }],
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // The editor's files. Its page (`app/editor/vscode/route.ts`) sends the same policy itself.
        source: '/editor/vscode/:version/:path*',
        missing: [{ type: 'host' as const, value: DEMO_HOSTNAME.replaceAll('.', '\\.') }],
        headers: [
          { key: 'Content-Security-Policy', value: editorCsp() },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
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
