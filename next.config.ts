import type { NextConfig } from 'next';
import { editorCsp } from './src/editors/vscode/csp';
import { CONTENT_HOST_PATTERN, CONTENT_SOURCE } from './src/lib/demos';
import { HOME_LIST_PARAMS, PRIVATE_PAGES } from './src/lib/private-paths';

const dev = process.env.NODE_ENV !== 'production';

/**
 * The content security policy, on every response. Scripts keep `'unsafe-inline'` because Next's inline
 * bootstrap scripts otherwise need a per-request nonce, and a nonce makes every page dynamic, which
 * rules out caching pages at the edge (DESIGN.md §2). Everything else is closed: scripts only from this
 * origin, inline and the analytics host, frames only from the content domain, nothing fetched elsewhere but analytics, and no plugin, base or form tricks. User
 * content is sanitized when committed, so this is the second lock, not the first.
 */
// Page analytics (`lib/analytics.ts`): the tracker script and the beacons it sends back to its own origin.
const ANALYTICS = 'https://analytics.potentialhedge.com';

// A plugin served by its author's dev server runs from their own machine, in their browser only.
const PLUGIN_DEV_SOURCES = 'http://localhost:* http://127.0.0.1:*';

const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${ANALYTICS}${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  // A plugin author's dev server (`handoffs/plugins.md` Phase 2): its manifest is read from the reader's own machine.
  `connect-src 'self' ${ANALYTICS} ${PLUGIN_DEV_SOURCES}${dev ? ' ws:' : ''}`,
  // Demos and plugins, which run on a host each of the content domain (`lib/demos.ts`), the web editor's frame
  // (`app/code`), and a plugin author's dev server.
  `frame-src 'self' ${CONTENT_SOURCE} ${PLUGIN_DEV_SOURCES}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js`: it tells a scanner which advisories to try.
  poweredByHeader: false,
  // The link-preview images read their font from disk (`server/og.tsx`); the Dockerfile copies `assets/` too, and this
  // keeps a plain standalone build working.
  outputFileTracingIncludes: {
    '/opengraph-image': ['./assets/fonts/*.ttf'],
    '/preview/[file]': ['./assets/fonts/*.ttf'],
  },
  // Traefik compresses instead (zstd, br or gzip, streams too: `docker-compose.prod.yml`). Next's is gzip only, and it
  // drops a route's own `Content-Encoding`, so a route can't compress for itself.
  compress: false,
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
        // Everything but the web editor and the API reference, which have policies of their own (`src/editors/vscode/csp.ts`,
        // `app/docs/route.ts`).
        source: '/:path((?!editor/|docs$).*)',
        // The content domain sends its own (`proxy.ts`, `server/demos/serve.ts`).
        missing: [{ type: 'host' as const, value: CONTENT_HOST_PATTERN }],
        headers: [
          { key: 'Content-Security-Policy', value: CSP },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // The editor's files. Its page (`app/editor/vscode/route.ts`) sends the same policy itself.
        source: '/editor/vscode/:version/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Cache-Control', value: 'public, max-age=86400' },
        ],
      },
      {
        // Not on the content domain, where a webview's pages get theirs from `proxy.ts` (`webviewCsp`), at run time:
        // it names the site, whose address isn't known when this is built.
        source: '/editor/vscode/:version/:path*',
        missing: [{ type: 'host' as const, value: CONTENT_HOST_PATTERN }],
        headers: [{ key: 'Content-Security-Policy', value: editorCsp() }],
      },
      {
        // The site's extension, which changes without VS Code's version (the path) changing: checked with the
        // server on every load, which answers 304 while it is the same. After the rule above, so this replaces it.
        source: '/editor/vscode/:version/potentialpaper/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
      {
        // The plugin SDK (`public/sdk/v1/pp.js`), on the content domain. v1 only ever grows, so it can be kept a day.
        source: '/sdk/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=86400' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
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
