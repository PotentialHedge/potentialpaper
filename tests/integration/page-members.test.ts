import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageAncestors, pageMembers } from '@/db/schema';
import { encodeReviewFile, submissionFilePath } from '@/lib/review-files';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { CONSUMERS } from '@/server/consumers';
import { rebuildConsumer, runConsumer } from '@/server/consumers/run';
import { linksConsumer, linksFrom, linksTo } from '@/server/page-links';
import { membersConsumer, scopeMemberCount, scopeMembers } from '@/server/page-members';
import { commitPage, createPage } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { closePool, resetDatabase } from './helpers';

/**
 * The consumers above the paper (`handoffs/pages.md` Phase 1): `links` ("what links here", on every kind) and
 * `members` (`page_members` from submissions and topic links, `page_ancestors` for roll-ups).
 */

beforeEach(resetDatabase);
afterAll(closePool);

let count = 0;

async function paper(arxiv: string) {
  return savePaper({
    title: `Paper ${arxiv}`,
    authors: [],
    abstract: null,
    year: 2027,
    venue: null,
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
    identifiers: [{ scheme: 'arxiv', value: arxiv }],
  });
}

async function person() {
  count += 1;
  const [account] = await getDb()
    .insert(accounts)
    .values({ handle: `person-${count}`, verifiedAt: new Date() })
    .returning();
  return { kind: 'account', accountId: account.id, isAdmin: false } as const;
}

const submission = (forum: string, venue: string) =>
  encodeReviewFile({
    schema: 'submission/1',
    id: forum,
    venue: { id: venue, name: venue, url: null },
    number: 1,
    url: `https://openreview.net/forum?id=${forum}`,
    license: 'CC-BY-4.0',
  });

async function submit(paperId: string, forum: string, venue: string) {
  const bot = await ensureBot(OPENREVIEW_BOT);
  await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
  await commitPage(
    paperId,
    null,
    bot,
    [{ path: submissionFilePath('openreview', forum), content: submission(forum, venue) }],
    'Import',
  );
}

async function catchUp() {
  for (const consumer of [linksConsumer, membersConsumer]) {
    expect(await runConsumer(consumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
  }
}

const members = async (scopeId: string, rollUp = true) =>
  (await scopeMembers(scopeId, { rollUp })).map((m) => m.paperId).sort();

describe('the links consumer', () => {
  it('is run by the worker', () => {
    expect(CONSUMERS.map((c) => c.name)).toEqual(expect.arrayContaining(['links', 'members']));
  });

  it('answers what links here on every kind, by the page or any identifier it answers to', async () => {
    const me = await person();
    const a = await paper('2401.00001');
    const b = await paper('2401.00002');
    const topic = await createPage('topic', 'linear-attention');
    await commitPage(
      a,
      null,
      me,
      [
        {
          path: 'community/links.jsonl',
          content: [
            '{"id":"1","to":"arxiv:2401.00002v3","label":"extends","note":"Same idea, faster."}',
            '{"id":"2","to":"topic:linear-attention","label":"in-topic"}',
            '{"id":"3","to":"topic:not-yet","label":"in-topic"}',
            '',
          ].join('\n'),
        },
      ],
      'Links',
    );
    await commitPage(
      topic.id,
      topic.head,
      me,
      [
        { path: 'topic.json', content: '{ "name": "Linear attention" }\n' },
        { path: 'community/links.jsonl', content: '{"id":"r","to":"topic:not-yet","label":"related"}\n' },
      ],
      'Topic',
    );
    await catchUp();

    const from = await linksFrom(a);
    expect(from.map((l) => [l.label, l.page.name, l.origin])).toEqual([
      ['extends', 'Paper 2401.00002', 'community'],
      ['in-topic', 'Linear attention', 'community'],
      ['in-topic', null, 'community'],
    ]);
    expect(from[0]).toMatchObject({ note: 'Same idea, faster.', page: { pageId: b, kind: 'paper' } });
    expect(await linksTo(b)).toMatchObject([{ label: 'extends', page: { pageId: a, name: 'Paper 2401.00001' } }]);
    expect(await linksTo(topic.id)).toMatchObject([{ label: 'in-topic', page: { pageId: a } }]);

    // A topic named before its page was made is found once it is, from both sides.
    const later = await createPage('topic', 'not-yet');
    expect((await linksTo(later.id)).map((l) => l.page.pageId).sort()).toEqual([a, topic.id].sort());
    expect((await linksFrom(a))[2].page).toMatchObject({ pageId: later.id, name: 'not-yet' });

    // Taking a link out takes it out of the index.
    await commitPage(a, await readHead(getDb(), a), me, [{ path: 'community/links.jsonl', content: '' }], 'No links');
    await catchUp();
    expect(await linksTo(b)).toEqual([]);
  });
});

describe('the members consumer', () => {
  it('makes papers members of a venue by their submissions, whichever page comes first', async () => {
    const p1 = await paper('2401.00011');
    const p2 = await paper('2401.00012');
    const p3 = await paper('2401.00013');
    await submit(p1, 'forum1', 'ICLR.cc/2027/Conference');
    await submit(p3, 'forum3', 'NeurIPS.cc/2026/Conference');
    await catchUp();

    const admin = { ...(await person()), isAdmin: true };
    const series = await createPage('venue', 'iclr');
    const edition = await createPage('venue', 'iclr/2027');
    await commitPage(
      edition.id,
      edition.head,
      admin,
      [{ path: 'venue.json', content: '{ "name": "ICLR 2027", "sources": ["openreview:ICLR.cc/2027/Conference"] }\n' }],
      'Sources',
    );
    await catchUp();
    expect(await members(edition.id)).toEqual([p1]);
    expect(await pageMembersVia(edition.id)).toEqual(['submission']);

    // A paper submitted after the venue's page is made joins it.
    await submit(p2, 'forum2', 'ICLR.cc/2027/Conference');
    await catchUp();
    expect(await members(edition.id)).toEqual([p1, p2].sort());

    // The series has its editions' papers, rolled up, and none of its own.
    expect(await getDb().select().from(pageAncestors)).toMatchObject([
      { pageId: edition.id, ancestorId: series.id, depth: 1 },
    ]);
    expect(await members(series.id)).toEqual([p1, p2].sort());
    expect(await members(series.id, false)).toEqual([]);
    expect(await scopeMemberCount(series.id)).toBe(2);

    // A rebuild gives the same rows.
    const before = await getDb().select().from(pageMembers);
    await rebuildConsumer(membersConsumer);
    await catchUp();
    expect((await getDb().select().from(pageMembers)).toSorted(byKey)).toEqual(before.toSorted(byKey));
  });

  it('makes papers members of the topics they link to, directly: a topic in a topic rolls nothing up', async () => {
    const me = await person();
    const broad = await createPage('topic', 'efficient-transformers');
    const narrow = await createPage('topic', 'linear-attention');
    await commitPage(
      narrow.id,
      narrow.head,
      me,
      [
        { path: 'topic.json', content: '{ "name": "Linear attention" }\n' },
        {
          path: 'community/links.jsonl',
          content: '{"id":"b","to":"topic:efficient-transformers","label":"in-topic"}\n',
        },
      ],
      'In efficient transformers',
    );
    const p = await paper('2006.16236');
    await commitPage(
      p,
      null,
      me,
      [{ path: 'community/links.jsonl', content: '{"id":"t","to":"topic:linear-attention","label":"in-topic"}\n' }],
      'Topic',
    );
    await catchUp();
    expect(await scopeMembers(narrow.id)).toEqual([{ paperId: p, via: ['in-topic'] }]);
    expect(await members(broad.id)).toEqual([]);
    expect(await getDb().select().from(pageAncestors)).toEqual([]);
    expect((await linksTo(broad.id)).map((l) => l.page.pageId)).toEqual([narrow.id]);
  });
});

const byKey = (a: { scopePageId: string; paperId: string; via: string }, b: typeof a) =>
  `${a.scopePageId}${a.paperId}${a.via}`.localeCompare(`${b.scopePageId}${b.paperId}${b.via}`);

async function pageMembersVia(scopeId: string): Promise<string[]> {
  return (await scopeMembers(scopeId)).flatMap((m) => m.via);
}
