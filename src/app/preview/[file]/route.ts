import { previewPng } from '@/server/preview-cache';
import { shareSubject } from '@/server/share';

export const dynamic = 'force-dynamic';

/**
 * A page's link preview, `/preview/<n>.png?v=<version>` (`server/og.tsx`), named by its short id; its page's metadata
 * points here. Drawn once per version and kept (`server/preview-cache.ts`). At the current version the image never
 * changes, so the edge and the chat apps keep it for good; any other address gets today's image for an hour. When the
 * server is busy drawing others it sends the site's own image instead, uncached, so a crawl can't pile up work.
 */
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const name = decodeURIComponent((await params).file);
  if (!name.endsWith('.png')) return new Response('Not found\n', { status: 404 });
  const subject = await shareSubject(name.slice(0, -'.png'.length));
  if (!subject) return new Response('Not found\n', { status: 404 });
  const image = await previewPng(subject);
  if (!image) {
    return new Response(null, {
      status: 302,
      headers: { Location: new URL('/opengraph-image', req.url).toString(), 'Cache-Control': 'no-store' },
    });
  }
  const current = new URL(req.url).searchParams.get('v') === image.version;
  return new Response(new Uint8Array(image.png), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, s-maxage=3600',
    },
  });
}
