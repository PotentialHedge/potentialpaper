import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addAnnouncement, allAnnouncements, currentAnnouncements, hideAnnouncement } from '@/server/announcements';
import { closePool, resetDatabase } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

describe('announcements', () => {
  it('shows the current ones newest first, signed-in ones only to the signed in', async () => {
    const everyone = await addAnnouncement({ body: 'Hello **all**' });
    const members = await addAnnouncement({ body: 'Hello members', signedInOnly: true });
    expect((await currentAnnouncements(true)).map((a) => a.id)).toEqual([members.id, everyone.id]);
    expect((await currentAnnouncements(false)).map((a) => a.id)).toEqual([everyone.id]);
  });

  it('hides one for good, once', async () => {
    const a = await addAnnouncement({ body: 'Soon gone' });
    expect(await hideAnnouncement(a.id)).toBe(true);
    expect(await hideAnnouncement(a.id)).toBe(false);
    expect(await currentAnnouncements(true)).toEqual([]);
    expect((await allAnnouncements())[0].hiddenAt).not.toBeNull();
  });

  it('refuses an empty body', async () => {
    await expect(addAnnouncement({ body: '  ' })).rejects.toThrow();
  });
});
