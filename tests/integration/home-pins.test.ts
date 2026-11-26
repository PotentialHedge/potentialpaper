import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims } from '@/db/schema';
import { followPaper } from '@/server/follows';
import { savePaper } from '@/server/papers';
import { searchPapers, searchPapersShared } from '@/server/search';
import { closePool, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

function paper(n: number): Promise<string> {
  return savePaper({
    title: `Paper ${n}`,
    authors: ['Ada Lovelace'],
    abstract: null,
    identifiers: [{ scheme: 'arxiv', value: `2101.0000${n}` }],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

const titles = async (filter: Parameters<typeof searchPapers>[0]) =>
  (await searchPapers({ sort: 'title', ...filter })).hits.map((h) => h.title);

describe('the home page’s pinned sections', () => {
  it('splits papers into the viewer’s own, the ones they follow, and the rest, none repeated', async () => {
    const [one, two, three] = await Promise.all([paper(1), paper(2), paper(3), paper(4)]);
    await signUp('ada@ethz.ch');
    const [account] = await getDb().select().from(accounts);
    const me = account.id;
    // Paper 1 is hers (and, as a confirmed author, followed); paper 2 is a pending claim; paper 3 is followed.
    await getDb()
      .insert(authorClaims)
      .values([
        {
          paperId: one,
          accountId: me,
          authorIndex: 0,
          authorName: 'Ada Lovelace',
          status: 'confirmed',
          identityId: 'a',
        },
        { paperId: two, accountId: me, authorIndex: 0, authorName: 'Ada Lovelace', identityId: 'b' },
      ]);
    await followPaper(one, me);
    await followPaper(three, me);

    expect(await titles({ authoredBy: me })).toEqual(['Paper 1', 'Paper 2']);
    expect(await titles({ followedBy: me, exceptAuthoredBy: me })).toEqual(['Paper 3']);
    expect(await titles({ exceptAuthoredBy: me, exceptFollowedBy: me })).toEqual(['Paper 4']);
    expect(await titles({ followedBy: me })).toEqual(['Paper 1', 'Paper 3']);

    // The list everyone shares, kept once in order, with this viewer's pinned papers taken out of it.
    const shared = async (filter: Parameters<typeof searchPapersShared>[0]) => {
      const { hits, total } = await searchPapersShared({ sort: 'title', ...filter });
      return { titles: hits.map((h) => h.title), total };
    };
    expect(await shared({})).toEqual({ titles: ['Paper 1', 'Paper 2', 'Paper 3', 'Paper 4'], total: 4 });
    expect(await shared({ exceptAuthoredBy: me, exceptFollowedBy: me })).toEqual({ titles: ['Paper 4'], total: 1 });
    expect(await shared({ exceptAuthoredBy: me, limit: 1, page: 2 })).toEqual({ titles: ['Paper 4'], total: 2 });
    expect(await shared({ q: 'paper', sort: 'newest', exceptFollowedBy: me, limit: 2 })).toMatchObject({ total: 2 });
  });
});
