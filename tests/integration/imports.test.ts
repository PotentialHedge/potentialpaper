import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { VENUES_BOT } from '@/server/venue-pages';
import { findPaper } from '@/server/papers';
import { mintToken } from '@/server/tokens';
import { versionsAt } from '@/server/versions';
import { api, closePool, resetDatabase, signUp } from './helpers';

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

beforeEach(resetDatabase);
afterAll(closePool);

describe('the import API', () => {
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
    expect((await api('POST', '/imports/papers', { token, body: PAPERS })).body).toEqual({ added: 0 });

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
          { venue: 'ICLR 2027', status: 'accepted', decision: 'Accept (Poster)', reviews: 'openreview/forum1' },
        ],
      },
    ]);

    // Another source's reviews are another bot's to import.
    const other = await api('POST', '/imports/submissions', {
      token,
      body: { ...body, venue: { ...VENUE, source: 'acl' } },
    });
    expect(other.status).toBe(403);

    // The `venues` bot writes them, as its grant has it (migration 0035).
    await ensureBot(VENUES_BOT);
    await grantBot(VENUES_BOT, 'venue.json', { grantedBy: 'system', kind: 'venue' });
    const venues = await api('POST', '/imports/venues', {
      token,
      body: { venues: [{ id: 'openreview:ICLR.cc/2027/Conference', name: 'ICLR 2027' }] },
    });
    expect(venues.body.written).toEqual(expect.arrayContaining(['iclr', 'iclr/2027']));
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
});
