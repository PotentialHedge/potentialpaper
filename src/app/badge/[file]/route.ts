import { createHash } from 'node:crypto';
import { renderBadge } from '@/lib/badge';
import { shareSubject, SITE_NAME } from '@/server/share';

export const dynamic = 'force-dynamic';

/** The message's colour by tone: the `up` and `down` tokens, else ink. */
const COLOR = { up: '#1a7f37', down: '#b31b1b', ink: '#1d1d1d' } as const;

/**
 * The embeddable badge, `/badge/<n>.svg`, for a README or a project page, linking to `/s/<n>`: a paper's latest
 * decision or submission, or its identifier; any other page's name. `?style=compact` drops the site name.
 *
 * Public and anonymous. Cached for five minutes, with an ETag of what it says, so GitHub's image proxy refreshes it.
 * An image, not JSON, so not part of `/api/v1`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const name = decodeURIComponent((await params).file);
  if (!name.endsWith('.svg')) return new Response('Not found\n', { status: 404 });
  const subject = await shareSubject(name.slice(0, -'.svg'.length));
  if (!subject) return new Response('Not found\n', { status: 404 });
  const compact = new URL(req.url).searchParams.get('style') === 'compact';
  const svg = renderBadge({
    label: SITE_NAME,
    message: subject.badge.message,
    color: COLOR[subject.badge.tone],
    compact,
  });
  const tag = `W/"${createHash('sha256').update(svg).digest('base64url').slice(0, 16)}"`;
  const headers = {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=300, s-maxage=300',
    ETag: tag,
  };
  if (req.headers.get('if-none-match') === tag) return new Response(null, { status: 304, headers });
  return new Response(svg, { headers });
}
