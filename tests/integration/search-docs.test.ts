import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { encodeReviewFile, type NoteFile, noteFilePath, submissionFilePath } from '@/lib/review-files';
import { MARK_END, MARK_START } from '@/lib/search';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { CONSUMERS } from '@/server/consumers';
import { rebuildConsumer, runConsumer } from '@/server/consumers/run';
import { type Actor, commitPage, type FileChange } from '@/server/pages/commit';
import { savePaper } from '@/server/papers';
import { searchPapers } from '@/server/search';
import { indexPage, searchConsumer } from '@/server/search-index';
import { closePool, resetDatabase } from './helpers';

const NO_LIMIT = { burst: 100_000, perSecond: 1000 };

beforeEach(resetDatabase);
afterAll(closePool);

let count = 0;
async function newPaper(title: string, abstract = 'An abstract about nothing much.'): Promise<string> {
  count += 1;
  return savePaper({
    title,
    authors: ['Ada Lovelace'],
    abstract,
    year: 2026,
    venue: null,
    source: 'openreview',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [{ scheme: 'openreview', value: `forum${count}` }],
  });
}

async function newAccount(): Promise<Actor> {
  count += 1;
  const [row] = await getDb()
    .insert(accounts)
    .values({ handle: `person-${count}`, verifiedAt: new Date() })
    .returning({ id: accounts.id });
  return { kind: 'account', accountId: row.id, isAdmin: false };
}

const heads = new Map<string, string>();
async function commit(paper: string, actor: Actor, changes: FileChange[]): Promise<string> {
  const result = await commitPage(paper, heads.get(paper) ?? null, actor, changes, 'Edit', { rateLimit: NO_LIMIT });
  if (result.status !== 'committed') throw new Error(`not committed: ${result.status}`);
  heads.set(paper, result.oid);
  return result.oid;
}

const submission = (id: string) =>
  encodeReviewFile({
    schema: 'submission/1',
    id,
    venue: { id: 'ICLR.cc/2027/Conference', name: 'ICLR 2027', url: null },
    number: 7,
    status: 'under_review',
    decision: null,
    url: `https://openreview.net/forum?id=${id}`,
    license: 'CC-BY-4.0',
  });

const review = (forum: string, id: string, weaknesses: string) =>
  encodeReviewFile({
    schema: 'review/1',
    id,
    replyTo: null,
    kind: 'review',
    invitation: 'Official_Review',
    signature: 'Reviewer B3x7',
    content: { rating: 6, weaknesses },
    createdAt: '2026-11-01T12:00:00.000Z',
    url: `https://openreview.net/forum?id=${forum}&noteId=${id}`,
    license: 'CC-BY-4.0',
  } satisfies NoteFile);

async function openreviewBot(): Promise<Actor> {
  const bot = await ensureBot(OPENREVIEW_BOT);
  await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
  return bot;
}

async function reviewFiles(forum: string, notes: [string, string][]): Promise<FileChange[]> {
  return [
    { path: submissionFilePath('openreview', forum), content: submission(forum) },
    ...notes.map(([id, text]) => ({ path: noteFilePath('openreview', forum, id), content: review(forum, id, text) })),
  ];
}

async function docs(paper: string) {
  const { rows } = await getDb().execute<{ path: string; kind: string; scope: string; text: string }>(
    sql`select path, kind, scope, text from search_docs where page_id = ${paper} order by path, n`,
  );
  return rows;
}

async function indexAll(): Promise<void> {
  const report = await runConsumer(searchConsumer, { retryNow: true });
  expect(report.status).toBe('caught-up');
}

describe('the search consumer', () => {
  it('is registered with the worker', () => {
    expect(CONSUMERS).toContain(searchConsumer);
  });

  it('indexes sections, links, versions and reviews, and follows edits and deletions', async () => {
    const person = await newAccount();
    const bot = await openreviewBot();
    const paper = await newPaper('A paper');
    await commit(paper, person, [
      { path: 'community/10-summary.md', content: '# Summary\n\nThe method uses **gradient checkpointing**.\n' },
      { path: 'community/20-empty.md', content: '' },
      { path: 'links/10-code.json', content: '{ "label": "Code", "url": "https://github.com/a/b" }\n' },
    ]);
    await commit(paper, bot, await reviewFiles('ForumA', [['NoteA', 'The baselines are weak.']]));
    await indexAll();

    expect((await docs(paper)).map((d) => [d.path, d.kind, d.scope])).toEqual([
      ['community/10-summary.md', 'section', 'page'],
      ['links/10-code.json', 'link', 'page'],
      ['reviews/openreview/foruma/notes/notea.json', 'note', 'reviews'],
      ['reviews/openreview/foruma/submission.json', 'submission', 'reviews'],
    ]);
    // Markup is taken out of a section's words.
    expect((await docs(paper))[0].text).toBe('Summary\n\nThe method uses gradient checkpointing.');

    await commit(paper, person, [
      { path: 'community/10-summary.md', content: '# Summary\n\nNow about sparse attention.\n' },
      { path: 'links/10-code.json', content: null },
    ]);
    await indexAll();
    const after = await docs(paper);
    expect(after.map((d) => d.path)).toEqual([
      'community/10-summary.md',
      'reviews/openreview/foruma/notes/notea.json',
      'reviews/openreview/foruma/submission.json',
    ]);
    expect(after[0].text).toContain('sparse attention');
  });

  it("doesn't read a file again when its blob is unchanged, and running twice changes nothing", async () => {
    const person = await newAccount();
    const paper = await newPaper('A paper');
    const first = await commit(paper, person, [
      { path: 'community/10-a.md', content: 'Alpha words.\n' },
      { path: 'community/20-b.md', content: 'Beta words.\n' },
    ]);
    expect(await indexPage(getDb(), paper, first)).toEqual({ indexed: 2, removed: 0 });
    const second = await commit(paper, person, [{ path: 'community/20-b.md', content: 'Gamma words.\n' }]);
    expect(await indexPage(getDb(), paper, second)).toEqual({ indexed: 1, removed: 0 });
    expect(await indexPage(getDb(), paper, second)).toEqual({ indexed: 0, removed: 0 });
    expect((await docs(paper)).map((d) => d.text)).toEqual(['Alpha words.', 'Gamma words.']);
  });

  it('rebuilds from nothing', async () => {
    const person = await newAccount();
    const paper = await newPaper('A paper');
    await commit(paper, person, [{ path: 'community/10-a.md', content: 'Alpha words.\n' }]);
    await indexAll();
    await rebuildConsumer(searchConsumer);
    expect(await docs(paper)).toEqual([]);
    await indexAll();
    expect(await docs(paper)).toHaveLength(1);
  });
});

describe('searching files', () => {
  async function seed() {
    const person = await newAccount();
    const bot = await openreviewBot();
    const quiet = await newPaper('Quiet title', 'Nothing to see.');
    await commit(quiet, bot, await reviewFiles('ForumQ', [['NoteQ', 'Possible data leakage between splits.']]));
    const loud = await newPaper('Data leakage in benchmarks', 'We study leakage.');
    await commit(loud, person, [{ path: 'community/10-notes.md', content: '# Notes\n\nOn tokenizers.\n' }]);
    const paged = await newPaper('Another paper', 'Unrelated.');
    await commit(paged, person, [
      { path: 'community/10-summary.md', content: '# Summary\n\nA section mentioning data leakage twice: leakage.\n' },
    ]);
    await indexAll();
    return { quiet, loud, paged };
  }

  it('looks only in titles and abstracts without in:', async () => {
    await seed();
    const { hits } = await searchPapers({ q: 'data leakage' });
    expect(hits.map((h) => h.title)).toEqual(['Data leakage in benchmarks']);
    expect(hits[0].matches).toEqual([]);
  });

  it('in:reviews finds papers by their reviews and names the file', async () => {
    await seed();
    const { hits, total } = await searchPapers({ q: 'in:reviews data leakage' });
    expect(total).toBe(1);
    expect(hits[0].title).toBe('Quiet title');
    expect(hits[0].matchCount).toBe(1);
    expect(hits[0].matches[0]).toMatchObject({
      path: 'reviews/openreview/forumq/notes/noteq.json',
      kind: 'note',
      label: 'Reviewer B3x7',
    });
    expect(hits[0].matches[0].snippet).toContain(`${MARK_START}leakage${MARK_END}`);
  });

  it('in:page finds sections, and in:all adds titles', async () => {
    await seed();
    const page = await searchPapers({ q: 'leakage in:page' });
    expect(page.hits.map((h) => h.title)).toEqual(['Another paper']);
    expect(page.hits[0].matches[0]).toMatchObject({
      path: 'community/10-summary.md',
      kind: 'section',
      label: 'Summary',
    });

    const all = await searchPapers({ q: 'in:all leakage' });
    expect(all.hits.map((h) => h.title).sort()).toEqual(['Another paper', 'Data leakage in benchmarks', 'Quiet title']);
    // Scopes add up.
    const both = await searchPapers({ q: 'in:page in:reviews leakage' });
    expect(both.hits.map((h) => h.title).sort()).toEqual(['Another paper', 'Quiet title']);
  });

  it('applies negation, OR and filters to file scopes', async () => {
    await seed();
    expect((await searchPapers({ q: 'in:all leakage -splits' })).hits.map((h) => h.title).sort()).toEqual([
      'Another paper',
      'Data leakage in benchmarks',
    ]);
    expect((await searchPapers({ q: 'in:page tokenizers OR splits' })).hits.map((h) => h.title)).toEqual([
      'Data leakage in benchmarks',
    ]);
    expect((await searchPapers({ q: 'in:reviews leakage title:quiet' })).total).toBe(1);
    expect((await searchPapers({ q: 'in:reviews leakage title:another' })).total).toBe(0);
  });

  it("doesn't fall back to misspelled titles when titles aren't searched", async () => {
    await seed();
    expect((await searchPapers({ q: 'quiet titl' })).total).toBe(1);
    expect((await searchPapers({ q: 'in:reviews quiet titel' })).total).toBe(0);
  });
});
