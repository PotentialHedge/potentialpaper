import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { pageCurrent, previewImages } from '@/db/schema';
import { insertPage } from '@/server/pages/kinds';
import { previewPng } from '@/server/preview-cache';
import { previewOfPage, shareSubject, shortIdOf } from '@/server/share';
import { closePool, resetDatabase } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

async function subjectOf(key: string) {
  const page = await insertPage('venue', key);
  return (await shareSubject(String(await shortIdOf(page.id))))!;
}

describe('preview images', () => {
  it('draws a page’s image once, and again only when what it shows changes', async () => {
    const subject = await subjectOf('iclr/2027');
    const first = (await previewPng(subject))!;
    expect(first.png.subarray(1, 4).toString()).toBe('PNG');
    const [kept] = await getDb().select().from(previewImages);
    expect((await previewPng(subject))!.version).toBe(first.version);
    const [still] = await getDb().select().from(previewImages);
    expect(still.drawnAt).toEqual(kept.drawnAt);

    await getDb()
      .insert(pageCurrent)
      .values({ pageId: subject.pageId, head: Buffer.alloc(20), updatedAt: new Date(), name: 'ICLR 2027' });
    const renamed = (await shareSubject(String(subject.shortId)))!;
    const second = (await previewPng(renamed))!;
    expect(second.version).not.toBe(first.version);
    expect(await getDb().select().from(previewImages)).toHaveLength(1);
    expect((await previewOfPage(subject.pageId))!.version).toBe(second.version);
  });

  it('draws a page once when asked for it twice at the same moment', async () => {
    const subject = await subjectOf('iclr/2027');
    const [a, b] = await Promise.all([previewPng(subject), previewPng(subject)]);
    expect(a!.png.equals(b!.png)).toBe(true);
    expect(await getDb().select().from(previewImages)).toHaveLength(1);
  });
});
