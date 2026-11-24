import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { accounts, pageRevisions, papers, submissions, venues } from '@/db/schema';
import { noteFilePath, submissionFilePath } from '@/lib/review-files';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { CONSUMERS } from '@/server/consumers';
import { rebuildConsumer, runConsumer } from '@/server/consumers/run';
import {
  IMPORT_RATE_LIMIT,
  importReviews,
  type NoteInput,
  type SubmissionInput,
  type VenueInput,
} from '@/server/import-reviews';
import { importSubmissions } from '@/server/import-submissions';
import { commitPage } from '@/server/pages/commit';
import { readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { findPaper } from '@/server/papers';
import { projectReviews, reviewsConsumer } from '@/server/review-projection';
import { submissionsOf } from '@/server/submissions';
import { currentVersions, setVersions, versionsAt } from '@/server/versions';
import { closePool, grantVenuesBot, resetDatabase } from './helpers';

beforeEach(async () => {
  await resetDatabase();
  await grantVenuesBot();
});
afterAll(closePool);

const VENUE: VenueInput = {
  source: 'openreview',
  id: 'Test.cc/2027/Conference',
  name: 'Test 2027',
  url: null,
  forms: { Official_Review: { label: 'Official review', fields: [{ key: 'rating', label: 'Rating' }] } },
  license: 'CC-BY-4.0',
};
const SHOWN_VENUE = {
  id: 'openreview:Test.cc/2027/Conference',
  name: 'Test 2027',
  // The venue's row is its page's projection: the source's own page for the venue.
  url: 'https://openreview.net/group?id=Test.cc%2F2027%2FConference',
  forms: VENUE.forms,
};
const OPTIONS = { rateLimit: IMPORT_RATE_LIMIT };

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

async function project(): Promise<void> {
  const report = await runConsumer(reviewsConsumer, { retryNow: true });
  expect(report.status).toBe('caught-up');
}

async function files(paper: string): Promise<Map<string, string>> {
  const head = await readHead(getDb(), paper);
  return readFiles(getDb(), paper, (await readCommit(getDb(), paper, head!)).tree);
}

async function revisions(paper: string) {
  return getDb()
    .select({ summary: pageRevisions.summary, paths: pageRevisions.paths })
    .from(pageRevisions)
    .where(eq(pageRevisions.pageId, paper))
    .orderBy(pageRevisions.seq);
}

describe('naming the authors when a review ends', () => {
  beforeEach(async () => {
    await ensureBot(OPENREVIEW_BOT);
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await importSubmissions([{ id: 'forum1', title: 'Sparse routing', abstract: 'x'.repeat(60) }]);
  });

  const named = { id: 'forum1', title: 'Sparse routing', abstract: 'x'.repeat(60), authors: ['Ada Lovelace'] };

  it('names nobody while the paper is under review', async () => {
    await importReviews(VENUE, [submission('forum1', [])], OPTIONS);
    await project();
    expect(await importSubmissions([named])).toEqual({ added: 0, named: 0 });
    expect((await findPaper({ scheme: 'openreview', value: 'forum1' }))!.paper.authors).toEqual([]);
  });

  it('writes them into paper.json once it was withdrawn, and only once', async () => {
    await importReviews(VENUE, [{ ...submission('forum1', []), status: 'withdrawn' }], OPTIONS);
    await project();
    expect(await importSubmissions([named])).toEqual({ added: 0, named: 1 });
    const paper = await paperId('forum1');
    expect(JSON.parse((await readText(getDb(), paper, (await files(paper)).get('paper.json')))!)).toMatchObject({
      title: 'Sparse routing',
      authors: ['Ada Lovelace'],
    });
    expect((await findPaper({ scheme: 'openreview', value: 'forum1' }))!.paper.authors).toEqual(['Ada Lovelace']);
    expect(await importSubmissions([{ ...named, authors: ['Someone Else'] }])).toEqual({ added: 0, named: 0 });
  });

  it('names a paper with no repo yet in its row', async () => {
    expect(await importSubmissions([named])).toEqual({ added: 0, named: 1 });
    expect((await findPaper({ scheme: 'openreview', value: 'forum1' }))!.paper.authors).toEqual(['Ada Lovelace']);
  });
});

describe('importing reviews', () => {
  beforeEach(async () => {
    await ensureBot(OPENREVIEW_BOT);
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await importSubmissions([
      { id: 'forum1', title: 'Sparse routing', abstract: 'x'.repeat(60) },
      { id: 'Forum2', title: 'Dense routing', abstract: 'y'.repeat(60) },
    ]);
  });

  it('is a consumer the worker runs', () => {
    expect(CONSUMERS).toContain(reviewsConsumer);
  });

  it("commits a submission's files as the bot, skips one we don't have, and the projection shows them", async () => {
    const result = await importReviews(
      VENUE,
      [submission('forum1', [review('a', 3), review('b', 1), review('c', 0, 'a')]), submission('missing', [])],
      OPTIONS,
    );
    const paper = await paperId('forum1');
    expect(result).toEqual({
      submissions: 1,
      notes: 3,
      skipped: 1,
      committed: 1,
      unchanged: 0,
      failed: [],
      changed: [paper],
    });
    const held = await files(paper);
    expect([...held.keys()].filter((path) => path.startsWith('reviews/')).sort()).toEqual([
      'reviews/openreview/forum1/notes/a.json',
      'reviews/openreview/forum1/notes/b.json',
      'reviews/openreview/forum1/notes/c.json',
      'reviews/openreview/forum1/submission.json',
    ]);
    const text = await readText(getDb(), paper, held.get(noteFilePath('openreview', 'forum1', 'c')));
    expect(JSON.parse(text!)).toMatchObject({ schema: 'review/1', id: 'c', replyTo: 'a', content: { rating: 0 } });
    expect((await revisions(paper)).at(-1)!.summary).toBe('Import Test 2027 submission forum1: 3 notes');

    // Nothing is shown until the worker projects the files.
    expect(await submissionsOf(paper)).toEqual([]);
    await project();
    const [found] = await submissionsOf(paper);
    expect(found).toMatchObject({ venue: SHOWN_VENUE, externalId: 'forum1', status: 'under_review', number: 1 });
    expect(found.notes.map((note) => [note.externalId, note.replyTo, note.content.rating])).toEqual([
      ['a', null, 3],
      ['b', null, 1],
      ['c', 'a', 0],
    ]);
    expect(await submissionsOf(await paperId('Forum2'))).toEqual([]);
  });

  it('commits nothing when nothing changed, and only what changed otherwise, deleting a note taken down', async () => {
    await importReviews(VENUE, [submission('forum1', [review('a', 3), review('b', 1)])], OPTIONS);
    const paper = await paperId('forum1');
    const before = await revisions(paper);

    const again = await importReviews(VENUE, [submission('forum1', [review('a', 3), review('b', 1)])], OPTIONS);
    expect(again).toMatchObject({ committed: 0, unchanged: 1 });
    expect(await revisions(paper)).toHaveLength(before.length);

    const later = await importReviews(
      VENUE,
      [{ ...submission('forum1', [review('a', 4), review('a', 4)]), status: 'accepted', decision: 'Accept' }],
      OPTIONS,
    );
    expect(later).toMatchObject({ committed: 1, notes: 1 });
    const last = (await revisions(paper)).at(-1)!;
    expect(last.summary).toBe('Update Test 2027 submission forum1: 1 note, 1 removed');
    // The decision is the version's to say, so its file changes, and submission.json doesn't.
    expect([...last.paths].sort()).toEqual([
      'reviews/openreview/forum1/notes/a.json',
      'reviews/openreview/forum1/notes/b.json',
      expect.stringMatching(/^versions\/v_[a-z2-9]{8}\.json$/),
    ]);

    await project();
    const all = await submissionsOf(paper);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'accepted', decision: 'Accept' });
    expect(all[0].notes.map((note) => [note.externalId, note.content.rating])).toEqual([['a', 4]]);
  });

  it('names folders by the lower-cased id and keeps the id as spelled inside', async () => {
    await importReviews(VENUE, [submission('Forum2', [review('XyZ', 2)])], OPTIONS);
    const paper = await paperId('Forum2');
    const held = await files(paper);
    expect(held.has(submissionFilePath('openreview', 'Forum2'))).toBe(true);
    expect(held.has('reviews/openreview/forum2/notes/xyz.json')).toBe(true);
    await project();
    const [found] = await submissionsOf(paper);
    expect(found.externalId).toBe('Forum2');
    expect(found.notes[0].externalId).toBe('XyZ');
  });

  it('says when a submission last changed, not when the page did', async () => {
    await importReviews(VENUE, [submission('forum1', [review('a', 3)])], OPTIONS);
    const paper = await paperId('forum1');
    await getDb().execute(sql`update page_revisions set at = '2026-11-01T00:00:00Z' where page_id = ${paper}`);
    await project();
    const [found] = await submissionsOf(paper);
    expect(found.fetchedAt).toEqual(new Date('2026-11-01T00:00:00Z'));
  });

  it("removes a submission's rows when its folder is gone, and a rebuild projects everything again", async () => {
    await importReviews(VENUE, [submission('forum1', [review('a', 3)]), submission('Forum2', [])], OPTIONS);
    await project();
    expect(await getDb().select().from(submissions)).toHaveLength(2);
    expect((await getDb().select().from(venues))[0].forms).toEqual(VENUE.forms);

    // A rebuild clears the projection and replays every page.
    await rebuildConsumer(reviewsConsumer);
    expect(await getDb().select().from(submissions)).toHaveLength(0);
    await project();
    expect(await getDb().select().from(submissions)).toHaveLength(2);

    // The bot takes a folder down.
    const paper = await paperId('forum1');
    const head = await readHead(getDb(), paper);
    const held = await files(paper);
    await commitPage(
      paper,
      head,
      await ensureBot(OPENREVIEW_BOT),
      [...held.keys()].filter((path) => path.startsWith('reviews/')).map((path) => ({ path, content: null })),
      'Take the submission down',
      OPTIONS,
    );
    expect(await projectReviews(getDb(), paper, (await readHead(getDb(), paper))!)).toEqual({
      submissions: 0,
      notes: 0,
      removed: 1,
    });
    expect(await submissionsOf(paper)).toEqual([]);
    expect(await submissionsOf(await paperId('Forum2'))).toHaveLength(1);
  });

  it("writes into the paper a duplicate was merged into, and shows a merged duplicate's own submissions", async () => {
    await importReviews(VENUE, [submission('Forum2', [review('a', 2)])], OPTIONS);
    await project();
    const survivor = await paperId('forum1');
    const duplicate = await paperId('Forum2');
    await getDb().update(papers).set({ mergedInto: survivor }).where(eq(papers.id, duplicate));
    expect((await submissionsOf(survivor)).map((s) => s.externalId)).toEqual(['Forum2']);

    await importReviews(VENUE, [submission('Forum2', [review('a', 3)])], OPTIONS);
    expect((await files(survivor)).has('reviews/openreview/forum2/submission.json')).toBe(true);
  });

  it("records the venue's decision in the version, which only its bot and admins change", async () => {
    await importReviews(VENUE, [submission('forum1', [review('a', 3)])], OPTIONS);
    const paper = await paperId('forum1');
    const { head, versions } = await versionsAt(paper);
    expect(versions).toMatchObject([
      {
        kind: 'submitted',
        label: 'Test 2027',
        url: 'https://openreview.net/forum?id=forum1',
        // The venue by its page, which keeps its name; the page shows it.
        submissions: [{ page: 'test/2027', status: 'under_review', reviews: 'openreview/forum1' }],
      },
    ]);
    expect(versions[0].submissions![0]).not.toHaveProperty('venue');
    expect((await currentVersions(paper))[0].submissions![0]).toMatchObject({ page: 'test/2027', venue: 'Test 2027' });
    const [{ verifiedAt: _v, ...rest }] = await getDb()
      .insert(accounts)
      .values({ handle: 'a-person', verifiedAt: new Date() })
      .returning();
    void _v;
    const person = { kind: 'account' as const, accountId: rest.id, isAdmin: false };
    const [version] = versions;
    const edit = (v: typeof version) => ({ baseOid: head, versions: [v], evidence: ['https://e.org'] });
    // A person may not decide for the venue...
    const decided = { ...version, submissions: [{ ...version.submissions![0], status: 'accepted' as const }] };
    await expect(setVersions(paper, person, edit(decided), OPTIONS)).rejects.toMatchObject({ status: 403 });
    await expect(
      setVersions(paper, person, edit({ ...version, submissions: undefined }), OPTIONS),
    ).rejects.toMatchObject({ status: 403 });
    // ...but may add to the version, and an admin may correct it.
    expect(await setVersions(paper, person, edit({ ...version, note: 'Four pages.' }), OPTIONS)).toMatchObject({
      status: 'committed',
    });
    const admin = { ...person, isAdmin: true };
    expect(
      await setVersions(
        paper,
        admin,
        { ...edit({ ...decided, note: 'Four pages.' }), baseOid: await readHead(getDb(), paper) },
        OPTIONS,
      ),
    ).toMatchObject({ status: 'committed' });

    // The import brings it back to what the venue says; the projection shows that.
    await importReviews(VENUE, [{ ...submission('forum1', [review('a', 3)]), status: 'rejected' }], OPTIONS);
    const after = await versionsAt(paper);
    expect(after.versions[0]).toMatchObject({
      note: 'Four pages.',
      submissions: [{ status: 'rejected', reviews: 'openreview/forum1' }],
    });
    await project();
    expect((await submissionsOf(paper))[0]).toMatchObject({ status: 'rejected' });
  });
});
