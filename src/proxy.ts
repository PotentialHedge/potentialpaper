import { NextResponse, type NextRequest } from 'next/server';
import { WEBVIEW_PRE_PATH, webviewCsp } from '@/editors/vscode/csp';
import { VSCODE_BASE } from '@/editors/vscode';
import { CONTENT_HOSTNAME, demoOfHost, isContentHost } from '@/lib/demos';
import { pluginHostOf } from '@/lib/plugins/origin';
import { serveDemo } from '@/server/demos/serve';
import { servePlugin } from '@/server/plugins/serve';
import { paperGate, shortGate } from '@/server/paper-gate';
import { openReviewAliasPath } from '@/lib/paper-ids';
import { siteUrl } from '@/server/site';

const PAPER_PATH = /^\/(abs|doi|openreview)(\/|$)/;
const SHORT_PATH = /^\/s\/([^/]+)$/;

/**
 * In front of the paper pages, and behind the edge's cache, so only an edge miss reaches it. Sends each
 * answer that must not be cached to a dynamic route, which tells Next and Cloudflare not to keep it.
 */
export async function proxy(req: NextRequest) {
  // User content has a domain of its own (`lib/demos.ts`), and nothing of the app is served there, `_next`
  // included: a demo's host serves its files, and a webview's only the webview's own pages. The Host header,
  // since Next gives `nextUrl` the host it was started on.
  const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '').toLowerCase();
  if (isContentHost(host)) {
    const snapshot = demoOfHost(host);
    if (snapshot) return serveDemo(req, snapshot);
    // A plugin's own host (`lib/plugins/origin.ts`).
    const plugin = pluginHostOf(host);
    if (plugin) return servePlugin(req, plugin);
    if (req.nextUrl.pathname.startsWith(`${VSCODE_BASE}${WEBVIEW_PRE_PATH}`)) {
      return NextResponse.next({ headers: { 'Content-Security-Policy': webviewCsp() } });
    }
    return new NextResponse('Not found\n', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  // The content domain itself serves the plugin SDK (`public/sdk/`) and nothing else. In development it is the app's
  // own host, which serves everything.
  if (host === CONTENT_HOSTNAME && host !== new URL(siteUrl()).hostname && !req.nextUrl.pathname.startsWith('/sdk/')) {
    return new NextResponse('Not found\n', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }
  const { pathname } = req.nextUrl;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    // Built by hand, since `nextUrl` would put the slash back.
    const to = `${siteUrl()}${pathname.replace(/\/+$/, '') || '/'}${req.nextUrl.search}`;
    return new NextResponse(null, { status: 308, headers: { Location: to } });
  }
  const to = req.nextUrl.clone();
  to.search = '';
  // A paper is shown at its short address, from the route of its canonical identifier.
  const short = SHORT_PATH.exec(pathname);
  if (short) {
    const gate = await shortGate(short[1]);
    switch (gate.action) {
      case 'render':
        to.pathname = gate.path;
        return NextResponse.rewrite(to);
      case 'redirect':
        to.pathname = gate.to;
        return NextResponse.redirect(to, { status: 308, headers: { 'Cache-Control': 'no-store' } });
      case 'other':
        return NextResponse.next();
      case 'missing':
        to.pathname = '/paper-missing';
        return NextResponse.rewrite(to);
    }
  }
  // Every identifier's address, OpenReview's own (`/forum?id=`) included, leads to the short one.
  const alias = openReviewAliasPath(pathname, req.nextUrl.searchParams);
  if (!alias && !PAPER_PATH.test(pathname)) return NextResponse.next();
  const gate = await paperGate(alias ?? pathname);
  switch (gate.action) {
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

// Every path, since any path on a demo's host can be one of its files, and the app's own paths return at once; but not a
// push (`POST /git/…/git-receive-pack`), Git LFS (`/git/…/info/lfs/…`, whose uploads are PDFs) or the API's uploads
// (`/api/v1/files`, `agent-files`, `workspace/files`). Next buffers a request body for the proxy, and past
// `proxyClientMaxBodySize` (10 MB) cuts it off, which would break a large pack or PDF. `server/git/http.ts` and the
// upload handlers (`server/api/handlers.ts`) refuse the content domain themselves.
export const config = {
  matcher: ['/((?!git/.+/git-receive-pack$|git/.+/info/lfs/|api/v1/(?:files|agent-files|workspace/files)$).*)'],
};
