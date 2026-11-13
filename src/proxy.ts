import { NextResponse, type NextRequest } from 'next/server';
import { DEMO_HOSTNAME } from '@/lib/demos';
import { serveDemo } from '@/server/demos/serve';
import { paperGate } from '@/server/paper-gate';
import { siteUrl } from '@/server/site';

const PAPER_PATH = /^\/(abs|doi|openreview)(\/|$)/;

/**
 * In front of the paper pages, and behind the edge's cache, so only an edge miss reaches it. Sends each
 * answer that must not be cached to a dynamic route, which tells Next and Cloudflare not to keep it.
 */
export async function proxy(req: NextRequest) {
  // Demos have a host of their own, and nothing of the app is served there, `_next` included. The Host header,
  // since Next gives `nextUrl` the host it was started on.
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
  if (host === DEMO_HOSTNAME) return serveDemo(req);
  const { pathname } = req.nextUrl;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    // Built by hand, since `nextUrl` would put the slash back.
    const to = `${siteUrl()}${pathname.replace(/\/+$/, '') || '/'}${req.nextUrl.search}`;
    return new NextResponse(null, { status: 308, headers: { Location: to } });
  }
  if (!PAPER_PATH.test(req.nextUrl.pathname)) return NextResponse.next();
  const gate = await paperGate(req.nextUrl.pathname);
  const to = req.nextUrl.clone();
  to.search = '';
  switch (gate.action) {
    case 'render':
      return NextResponse.next();
    case 'redirect':
      to.pathname = gate.to;
      return NextResponse.redirect(to, { status: 308, headers: { 'Cache-Control': 'no-store' } });
    case 'missing':
      to.pathname = '/paper-missing';
      return NextResponse.rewrite(to);
    case 'unavailable':
      to.pathname = '/paper-unavailable';
      return NextResponse.rewrite(to);
  }
}

// Every path, since any path on the demo host can be a demo's file, and the app's own paths return at once; but not a
// push (`POST /git/…/git-receive-pack`). Next buffers a request body for the proxy, and past
// `proxyClientMaxBodySize` (10 MB) cuts it off, which would break a large pack. `server/git/http.ts` refuses a
// push on the demo host itself.
export const config = {
  matcher: ['/((?!git/.+/git-receive-pack$).*)'],
};
