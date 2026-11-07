import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { papers } from '@/db/schema';
import { importReviews, type NoteInput, type SubmissionInput } from '@/server/import-reviews';
import { importSubmissions } from '@/server/import-submissions';
import { findPaper } from '@/server/papers';
import { submissionsOf } from '@/server/submissions';
import { closePool, resetDatabase } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

const VENUE = {
  id: 'openreview:Test.cc/2027/Conference',
  name: 'Test 2027',
  url: null,
  forms: { Official_Review: { label: 'Official review', fields: [{ key: 'rating', label: 'Rating' }] } },
};
const FETCHED = new Date('2026-11-06T13:38:26Z');

function review(externalId: string, rating: number, replyTo: string | null = null): NoteInput {
  return {
    externalId,
    replyTo,
    kind: replyTo ? 'comment' : 'review',
    invitation: replyTo ? 'Official_Comment' : 'Official_Review',
    signature: `Reviewer ${externalId}`,
    content: { rating, summary: 'Fine.' },
    license: 'CC-BY-4.0',
    url: `https://openreview.net/forum?id=forum1&noteId=${externalId}`,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    modifiedAt: null,
  };
}

function submission(id: string, notes: NoteInput[]): SubmissionInput {
  return {
    externalId: id,
    paper: { scheme: 'openreview', value: id },
    number: 1,
    status: 'under_review',
    decision: null,
    url: `https://openreview.net/forum?id=${id}`,
    notes,
  };
}

async function paperId(id: string): Promise<string> {
  const found = await findPaper({ scheme: 'openreview', value: id });
  return found!.paper.id;
}

describe('importing reviews', () => {
  beforeEach(async () => {
    await importSubmissions(
      [
        { id: 'forum1', title: 'Sparse routing', abstract: 'x'.repeat(60) },
        { id: 'forum2', title: 'Dense routing', abstract: 'y'.repeat(60) },
      ],
      { name: 'Test 2027 (under review)', year: 2027 },
    );
  });

  it("attaches a submission and its notes to the paper, and skips one we don't have", async () => {
    const result = await importReviews(
      VENUE,
      [submission('forum1', [review('a', 3), review('b', 1), review('c', 0, 'a')]), submission('missing', [])],
      FETCHED,
    );
    expect(result).toEqual({ submissions: 1, notes: 3, skipped: 1 });
    const [found] = await submissionsOf(await paperId('forum1'));
    expect(found).toMatchObject({ venue: VENUE, externalId: 'forum1', status: 'under_review', fetchedAt: FETCHED });
    expect(found.notes.map((note) => [note.externalId, note.replyTo, note.content.rating])).toEqual([
      ['a', null, 3],
      ['b', null, 1],
      ['c', 'a', 0],
    ]);
    expect(await submissionsOf(await paperId('forum2'))).toEqual([]);
  });

  it('replaces the notes on a second run, so a note taken down goes', async () => {
    await importReviews(VENUE, [submission('forum1', [review('a', 3), review('b', 1)])], FETCHED);
    const later = new Date('2026-11-20T00:00:00Z');
    await importReviews(
      VENUE,
      [{ ...submission('forum1', [review('a', 4), review('a', 4)]), status: 'accepted', decision: 'Accept' }],
      later,
    );
    const all = await submissionsOf(await paperId('forum1'));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'accepted', decision: 'Accept', fetchedAt: later });
    expect(all[0].notes.map((note) => [note.externalId, note.content.rating])).toEqual([['a', 4]]);
  });

  it("shows a duplicate's submissions on the paper it was merged into", async () => {
    await importReviews(VENUE, [submission('forum2', [review('a', 2)])], FETCHED);
    const survivor = await paperId('forum1');
    await getDb()
      .update(papers)
      .set({ mergedInto: survivor })
      .where(eq(papers.id, await paperId('forum2')));
    expect((await submissionsOf(survivor)).map((s) => s.externalId)).toEqual(['forum2']);
  });
});
