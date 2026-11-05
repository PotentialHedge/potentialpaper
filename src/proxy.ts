import { NextResponse, type NextRequest } from 'next/server';
import { paperGate } from '@/server/paper-gate';

/**
 * In front of the paper pages, and behind the edge's cache, so only an edge miss reaches it. Sends each
 * answer that must not be cached to a dynamic route, which tells Next and Cloudflare not to keep it.
 */
export async function proxy(req: NextRequest) {
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

export const config = { matcher: ['/abs/:path*', '/doi/:path*', '/openreview/:path*'] };
