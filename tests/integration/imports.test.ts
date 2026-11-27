import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageCurrent, venues as venuesTable } from '@/db/schema';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { findKeyedPage } from '@/server/pages/kinds';
import { runConsumer } from '@/server/consumers/run';
import { findPaper } from '@/server/papers';
import { reviewsConsumer } from '@/server/review-projection';
import { mintToken } from '@/server/tokens';
import { versionsAt } from '@/server/versions';
import { api, closePool, grantVenuesBot, resetDatabase, signUp } from './helpers';

process.env.EVIDENCE_FILES_DIR = mkdtempSync(join(tmpdir(), 'evidence-'));

const FORUM = 'https://openreview.net/forum?id=forum1';
const VENUE = {
  source: 'openreview',
  id: 'ICLR.cc/2027/Conference',
  name: 'ICLR 2027',
  url: 'https://openreview.net/group?id=ICLR.cc/2027/Conference',
  forms: { Official_Review: { label: 'Official review', fields: [{ key: 'rating', label: 'Rating' }] } },
  license: 'CC-BY-4.0',
};
const PAPERS = {
  venue: { name: 'ICLR 2027 (under review)', year: 2027 },
  papers: [{ openreview: 'forum1', title: 'Sparse routing', abstract: 'x'.repeat(60) }],
};

async function botToken(handle = OPENREVIEW_BOT) {
  await ensureBot(handle);
  const [account] = await getDb().select().from(accounts).where(eq(accounts.handle, handle));
  return (await mintToken({ account, name: 'import tool', scopes: ['read', 'write'] })).token;
}

function submission(notes = 1) {
  return {
    externalId: 'forum1',
    paper: { scheme: 'openreview', value: 'forum1' },
    number: 7,
    status: 'accepted',
    decision: 'Accept (Poster)',
    submittedAt: '2026-09-20T10:00:00Z',
    url: FORUM,
    notes: Array.from({ length: notes }, (_, i) => ({
      externalId: `r${i}`,
      replyTo: null,
      kind: 'review',
      invitation: 'Official_Review',
      signature: `Reviewer ${i}`,
      content: { rating: 6 },
      license: 'CC-BY-4.0',
      url: `${FORUM}&noteId=r${i}`,
      createdAt: '2026-11-01T00:00:00Z',
      modifiedAt: null,
    })),
  };
}

beforeEach(async () => {
  await resetDatabase();
  await grantVenuesBot();
});
afterAll(closePool);

describe('the import API', () => {
  it("writes a venue's schedule into the imported entry, and an import of its reviews keeps it", async () => {
    const token = await botToken();
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await api('POST', '/imports/papers', { token, body: PAPERS });
    const body = { venue: VENUE, submissions: [submission()] };
    await api('POST', '/imports/submissions', { token, body });

    const poster = {
      kind: 'Poster',
      session: 'Poster Session 1',
      room: 'Hall 1 - 4',
      board: '#S12',
      start: '2026-12-08T10:00:00+11:00',
      end: '2026-12-08T13:00:00+11:00',
    };
    const schedule = {
      source: 'openreview',
      submissions: [
        { externalId: 'forum1', presentations: [poster] },
        { externalId: 'missing', presentations: [poster] },
      ],
    };
    const written = await api('POST', '/imports/presentations', { token, body: schedule });
    expect(written.body).toMatchObject({ submissions: 1, skipped: 1, committed: 1, failed: [] });
    expect((await api('POST', '/imports/presentations', { token, body: schedule })).body).toMatchObject({
      unchanged: 1,
    });
    // The reviews' import doesn't know the schedule, and keeps it.
    await api('POST', '/imports/submissions', { token, body: { venue: VENUE, submissions: [submission(2)] } });

    const found = await findPaper({ scheme: 'openreview', value: 'forum1' });
    const { versions } = await versionsAt(found!.paper.id);
    expect(versions[0].submissions![0]).toMatchObject({ decision: 'Accept (Poster)', presentations: [poster] });
    expect(await runConsumer(reviewsConsumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
    const forPlugins = await api('GET', '/pages/openreview:forum1/submissions');
    expect(forPlugins.body.submissions[0]).toMatchObject({ presentations: [poster] });
  });

  it("is a bot's token only: not a person's, not a bot without grants", async () => {
    const cookie = await signUp('ada@ethz.ch');
    expect((await api('POST', '/imports/papers', { cookie, body: PAPERS })).status).toBe(403);
    const [ada] = await getDb().select().from(accounts);
    const { token: person } = await mintToken({ account: ada, name: 'agent', scopes: ['write'] });
    expect((await api('POST', '/imports/papers', { token: person, body: PAPERS })).status).toBe(403);
    const ungranted = await botToken();
    expect((await api('POST', '/imports/papers', { token: ungranted, body: PAPERS })).status).toBe(403);
  });

  it('adds papers, imports their submissions with reviews, dates the version, makes the venue pages', async () => {
    const token = await botToken();
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });

    const added = await api('POST', '/imports/papers', { token, body: PAPERS });
    expect(added).toMatchObject({ status: 200, body: { added: 1 } });
    expect((await api('POST', '/imports/papers', { token, body: PAPERS })).body).toEqual({ added: 0, named: 0 });

    const listed = await api('GET', '/imports/papers?scheme=openreview', { token });
    expect(listed.body).toMatchObject({
      papers: [{ title: 'Sparse routing', identifiers: [{ scheme: 'openreview', value: 'forum1' }], pdf: null }],
      next: null,
    });

    const body = { venue: VENUE, submissions: [submission(2)] };
    const imported = await api('POST', '/imports/submissions', { token, body });
    expect(imported.body).toMatchObject({ submissions: 1, notes: 2, committed: 1, failed: [] });
    expect((await api('POST', '/imports/submissions', { token, body })).body).toMatchObject({ unchanged: 1 });

    const found = await findPaper({ scheme: 'openreview', value: 'forum1' });
    const { versions } = await versionsAt(found!.paper.id);
    expect(versions).toMatchObject([
      {
        kind: 'submitted',
        date: '2026-09-20',
        url: FORUM,
        submissions: [
          { page: 'iclr/2027', status: 'accepted', decision: 'Accept (Poster)', reviews: 'openreview/forum1' },
        ],
      },
    ]);

    // Another source's reviews are another bot's to import.
    const other = await api('POST', '/imports/submissions', {
      token,
      body: { ...body, venue: { ...VENUE, source: 'acl' } },
    });
    expect(other.status).toBe(403);

    // The import made the venue's pages (the `venues` bot writes them, as its grant has it, migration 0035), and put
    // its forms on the edition's page; asking again writes nothing.
    const edition = await findKeyedPage(getDb(), 'venue', 'iclr/2027');
    expect(edition).not.toBeNull();
    const [row] = await getDb()
      .select()
      .from(venuesTable)
      .where(eq(venuesTable.id, 'openreview:ICLR.cc/2027/Conference'));
    expect(row).toMatchObject({ name: 'ICLR 2027', forms: VENUE.forms });
    const venues = await api('POST', '/imports/venues', {
      token,
      body: { venues: [{ id: 'openreview:ICLR.cc/2027/Conference', name: 'ICLR 2027' }] },
    });
    expect(venues.body.written).toEqual([]);
    // A venue with no page yet isn't imported.
    const workshop = await api('POST', '/imports/submissions', {
      token,
      body: { ...body, venue: { ...VENUE, id: 'ICLR.cc/2027/Workshop/X' } },
    });
    expect(workshop.status).toBe(422);
    expect(workshop.body.error.message).toMatch(/has no venue page/);
    const elsewhere = await api('POST', '/imports/venues', {
      token,
      body: { venues: [{ id: 'acl:ACL/2027', name: 'ACL 2027' }] },
    });
    expect(elsewhere.status).toBe(403);
  });

  it("attaches a stored PDF to the version at the forum, and folds a source's versions in by address", async () => {
    const token = await botToken();
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await api('POST', '/imports/papers', { token, body: PAPERS });
    await api('POST', '/imports/submissions', { token, body: { venue: VENUE, submissions: [submission()] } });
    const paper = { scheme: 'openreview', value: 'forum1' };

    const form = new FormData();
    form.set('file', new File(['%PDF-1.4\n% sparse\n%%EOF\n'], 'paper.pdf', { type: 'application/pdf' }));
    const stored = await api('POST', '/files', { token, form });
    expect(stored.status).toBe(201);
    const pdf = { url: stored.body.url, license: 'CC-BY-4.0', source: 'https://openreview.net/pdf?id=forum1' };
    const at = { url: FORUM, label: 'ICLR 2027' };
    expect((await api('POST', '/imports/pdfs', { token, body: { paper, pdf, at } })).body.changed).toBe(true);
    expect((await api('POST', '/imports/pdfs', { token, body: { paper, pdf, at } })).body.changed).toBe(false);

    const later = 'https://openreview.net/forum?id=forum9';
    const res = await api('POST', '/imports/versions', {
      token,
      body: {
        paper,
        versions: [
          { label: 'ICLR 2027', kind: 'submitted', url: FORUM, title: 'Sparse routing' },
          { label: 'NeurIPS 2027', kind: 'submitted', url: later, date: '2027-05-01' },
        ],
      },
    });
    expect(res.body.changed).toBe(true);
    const found = await findPaper(paper as never);
    const { versions } = await versionsAt(found!.paper.id);
    expect(versions).toHaveLength(2);
    const first = versions.find((v) => v.url === FORUM)!;
    // What the import of reviews wrote, and the PDF, are kept.
    expect(first.pdf).toMatchObject({ sha256: stored.body.sha256, source: pdf.source, license: 'CC-BY-4.0' });
    expect(first.submissions?.[0]).toMatchObject({ reviews: 'openreview/forum1' });
    expect(versions.find((v) => v.url === later)).toMatchObject({ label: 'NeurIPS 2027', date: '2027-05-01' });
  });

  it('adds the links an abstract names under the title, once, numbering a label it has', async () => {
    const token = await botToken();
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await api('POST', '/imports/papers', { token, body: PAPERS });
    const paper = { scheme: 'openreview', value: 'forum1' };
    const links = [
      { label: 'Code', url: 'https://github.com/ada/sparse' },
      { label: 'Code', url: 'https://github.com/ada/sparse-data' },
    ];
    const first = await api('POST', '/imports/links', { token, body: { paper, links } });
    expect(first).toMatchObject({ status: 200, body: { changed: true } });
    // The same address, written another way, is there already.
    const again = await api('POST', '/imports/links', {
      token,
      body: { paper, links: [{ label: 'Code', url: 'http://www.github.com/ada/sparse/' }] },
    });
    expect(again.body.changed).toBe(false);
    const found = await findPaper(paper as never);
    const [row] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, found!.paper.id));
    expect(row.links).toEqual([
      { label: 'Code', url: 'https://github.com/ada/sparse' },
      { label: 'Code 2', url: 'https://github.com/ada/sparse-data' },
    ]);
  });
});
