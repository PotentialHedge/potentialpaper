import { NextResponse } from 'next/server';
import { shareSubject } from '@/server/share';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/**
 * The short link, `/s/<n>`: a page's `short_id` redirects to its page. A 307, so the page can move without browsers
 * keeping the old target for good; crawlers follow it and read the page's own preview. Built on `siteUrl()`, never
 * `req.url`, which behind the proxy is the server's bind address.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ n: string }> }) {
  const subject = await shareSubject((await params).n);
  if (!subject) return new NextResponse('Not found\n', { status: 404 });
  return NextResponse.redirect(new URL(subject.path, siteUrl()), {
    status: 307,
    headers: { 'Cache-Control': 'public, max-age=300' },
  });
}
