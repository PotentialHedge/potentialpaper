import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { previewImages } from '@/db/schema';
import { WorkQueue } from '@/lib/work-queue';
import { previewImage } from './og';
import { previewVersion, type ShareSubject } from './share';
import { siteUrl } from './site';

/**
 * Link-preview images, drawn once and kept (`preview_images`), so crawlers going through every page can't make the
 * server draw on every request. An image is drawn only when its page has none for what it now shows
 * (`previewVersion`); at most `MAX_DRAWING` are drawn at once, with `MAX_WAITING` in line behind them, and past that
 * the caller is told the server is busy (`null`) and sends the site's own image instead. Two requests for the same
 * image share one drawing.
 */

export const MAX_DRAWING = 2;
export const MAX_WAITING = 8;

const queue = new WorkQueue<Buffer>(MAX_DRAWING, MAX_WAITING);

/** The page's preview as a PNG, with its version; `null` when it would have to be drawn and the server is busy. */
export async function previewPng(
  subject: ShareSubject,
  database: Database = getDb(),
): Promise<{ png: Buffer; version: string } | null> {
  const version = previewVersion(subject);
  const [kept] = await database
    .select({ version: previewImages.version, png: previewImages.png })
    .from(previewImages)
    .where(eq(previewImages.pageId, subject.pageId));
  if (kept?.version === version) return { png: kept.png, version };

  const drawn = queue.run(`${subject.pageId}:${version}`, async () => {
    const image = await previewImage(subject, new URL(siteUrl()).host);
    const png = Buffer.from(await image.arrayBuffer());
    await database
      .insert(previewImages)
      .values({ pageId: subject.pageId, version, png })
      .onConflictDoUpdate({ target: previewImages.pageId, set: { version, png, drawnAt: new Date() } });
    return png;
  });
  if (!drawn) return null;
  return { png: await drawn, version };
}
