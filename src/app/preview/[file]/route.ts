import { previewImage } from '@/server/og';
import { shareSubject } from '@/server/share';
import { siteUrl } from '@/server/site';

export const dynamic = 'force-dynamic';

/** A page's link preview, `/preview/<n>.png` (`server/og.tsx`), named by its short id; its page's metadata points here. */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const name = decodeURIComponent((await params).file);
  if (!name.endsWith('.png')) return new Response('Not found\n', { status: 404 });
  const subject = await shareSubject(name.slice(0, -'.png'.length));
  if (!subject) return new Response('Not found\n', { status: 404 });
  return previewImage(subject, new URL(siteUrl()).host);
}
