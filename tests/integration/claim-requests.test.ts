import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accountEmails, accounts, authorClaims, pageCurrent, pdfDocuments, submissions, venues } from '@/db/schema';
import { commitPage } from '@/server/pages/commit';
import { savePaper } from '@/server/papers';
import { linkedAuthors } from '@/server/user-pages';
import { api, closePool, lastMailTo, resetDatabase, signUp } from './helpers';

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

async function paper(emails: string[] = [], firstPageRaw = ''): Promise<string> {
  const paperId = await savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
  // A page has a current row once something is committed to it.
  const editor = await accountOf('grace@mit.edu');
  const actor = { kind: 'account', accountId: editor.id, isAdmin: false } as const;
  await commitPage(paperId, null, actor, [{ path: 'community/10-notes.md', content: '# Notes\n\nHi.\n' }], 'Notes');
  const sha256 = 'a'.repeat(64);
  await getDb()
    .update(pageCurrent)
    .set({ pdf: { sha256, bytes: 1, url: `https://example.org/${sha256}.pdf` } as never })
    .where(eq(pageCurrent.pageId, paperId));
  await getDb().insert(pdfDocuments).values({ sha256, url: 'https://example.org/a.pdf', emails, firstPageRaw });
  return paperId;
}

async function accountOf(email: string) {
  const cookie = await signUp(email);
  const me = await api('PATCH', '/me', { cookie, body: { handle: email.split('@')[0], showInstitution: true } });
  expect(me.status).toBe(200);
  return { cookie, id: me.body.id as string };
}

const claimOf = async (paperId: string, accountId: string) =>
  (
    await getDb()
      .select()
      .from(authorClaims)
      .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.accountId, accountId)))
  )[0];

afterAll(closePool);
beforeEach(resetDatabase);

describe('claiming with an address printed on the paper', () => {
  it('confirms a non-institutional address with a code, keeps it apart from affiliations, and confirms the claim', async () => {
    const paperId = await paper(['noam.shazeer@gmail.com']);
    const noam = await accountOf('noam@ethz.ch');

    const refused = await api('POST', '/claims/code', {
      cookie: noam.cookie,
      body: { paper: PAPER, authorIndex: 1, email: 'someone@else.com' },
    });
    expect(refused.status).toBe(422);

    const sent = await api('POST', '/claims/code', {
      cookie: noam.cookie,
      body: { paper: PAPER, authorIndex: 1, email: 'noam.shazeer@gmail.com' },
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ sent: true, claim: { status: 'pending', authorName: 'Noam Shazeer' } });
    const code = /\b(\d{6})\b/.exec(lastMailTo('noam.shazeer@gmail.com')?.subject ?? '')?.[1];
    expect(code).toBeTruthy();

    const wrong = await api('POST', '/claims/code/confirm', {
      cookie: noam.cookie,
      body: { paper: PAPER, email: 'noam.shazeer@gmail.com', code: code === '000000' ? '111111' : '000000' },
    });
    expect(wrong.status).toBe(422);

    const confirmed = await api('POST', '/claims/code/confirm', {
      cookie: noam.cookie,
      body: { paper: PAPER, email: 'noam.shazeer@gmail.com', code },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.claim).toMatchObject({ status: 'confirmed', method: 'email', authorIndex: 1 });

    const [other] = await getDb().select().from(accountEmails).where(eq(accountEmails.accountId, noam.id));
    expect(other.verifiedAt).not.toBeNull();
    const [account] = await getDb().select().from(accounts).where(eq(accounts.id, noam.id));
    expect(account.institutions).toEqual(['ETH Zurich']);
  });
});

describe('asking co-authors', () => {
  it('mails the confirmed authors, and the first answer decides', async () => {
    const paperId = await paper(['ashish@ethz.ch'], 'Ashish Vaswani\nGoogle\nashish@ethz.ch\n');
    const ashish = await accountOf('ashish@ethz.ch');
    expect((await claimOf(paperId, ashish.id))?.status).toBe('confirmed');

    const niki = await accountOf('niki@ethz.ch');
    const asked = await api('POST', '/claims/ask', {
      cookie: niki.cookie,
      body: { paper: PAPER, authorIndex: 2, evidence: 'I wrote section 3.' },
    });
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ asked: ['Ashish Vaswani'], claim: { status: 'pending' } });
    const mail = lastMailTo('ashish@ethz.ch');
    expect(mail?.text).toContain('niki@ethz.ch');
    expect(mail?.text).toContain('I wrote section 3.');

    const claim = await claimOf(paperId, niki.id);
    const denied = await api('POST', '/me/papers/co-authors/deny', {
      cookie: ashish.cookie,
      body: { paper: PAPER, claim: claim.id },
    });
    expect(denied.status).toBe(200);
    expect((await claimOf(paperId, niki.id)).status).toBe('rejected');
    expect(lastMailTo('niki@ethz.ch')?.subject).toContain('not confirmed');

    // Already decided: confirming it now fails.
    const late = await api('POST', '/me/papers/co-authors', {
      cookie: ashish.cookie,
      body: { paper: PAPER, claim: claim.id },
    });
    expect(late.status).toBe(404);
  });

  it('waits when no co-author is here, and asks the first one to join', async () => {
    const paperId = await paper(['ashish@ethz.ch'], 'Ashish Vaswani\nGoogle\nashish@ethz.ch\n');
    const niki = await accountOf('niki@ethz.ch');
    const asked = await api('POST', '/claims/ask', { cookie: niki.cookie, body: { paper: PAPER, authorIndex: 2 } });
    expect(asked.body).toMatchObject({ asked: [], claim: { status: 'pending' } });

    // Ashish signs up with the address on the paper: made its author, and asked about Niki.
    const ashish = await accountOf('ashish@ethz.ch');
    expect((await claimOf(paperId, ashish.id))?.status).toBe('confirmed');
    expect(lastMailTo('ashish@ethz.ch')?.subject).toContain('Is this Niki Parmar?');
  });
});

describe('claim suggestions', () => {
  it('puts papers with your address first, then by name, and searches', async () => {
    await paper(['ashish@ethz.ch'], 'Ashish Vaswani\nGoogle\nashish@ethz.ch\n');
    const other = await savePaper({
      title: 'Self-Attention with Relative Position Representations',
      authors: ['Peter Shaw', 'Jakob Uszkoreit', 'Ashish Vaswani'],
      abstract: null,
      year: 2018,
      venue: null,
      identifiers: [{ scheme: 'arxiv', value: '1803.02155' }],
      source: 'arxiv',
      metadataLicense: 'CC0-1.0',
      abstractLicense: null,
    });
    expect(other).toBeTruthy();

    const someone = await accountOf('someone@ethz.ch');
    const empty = await api('GET', '/me/claim-suggestions', { cookie: someone.cookie });
    expect(empty.body.papers).toEqual([]);
    const searched = await api('GET', '/me/claim-suggestions?q=vaswani', { cookie: someone.cookie });
    expect(searched.body.papers).toHaveLength(2);

    // Ashish is made the author of the first by address; the second shows by name.
    const ashish = await accountOf('ashish@ethz.ch');
    const mine = await api('GET', '/me/claim-suggestions', { cookie: ashish.cookie });
    expect(mine.body.papers.map((p: { title: string }) => p.title)).toEqual([
      'Self-Attention with Relative Position Representations',
      'Attention Is All You Need',
    ]);
    expect(mine.body.papers[0]).toMatchObject({ byEmail: false, likely: 2, mine: null });
    expect(mine.body.papers[1]).toMatchObject({ byEmail: true, mine: { status: 'confirmed' } });
  });
});

describe('a paper under review', () => {
  async function underReview(paperId: string) {
    await getDb().insert(venues).values({ id: 'openreview:ICLR.cc/2027/Conference', name: 'ICLR 2027' });
    await getDb().insert(submissions).values({
      paperId,
      venueId: 'openreview:ICLR.cc/2027/Conference',
      externalId: 'abc',
      status: 'under_review',
      fetchedAt: new Date(),
    });
  }

  it('is claimed only by an address on it, hides the names, and links no one', async () => {
    const paperId = await paper(['ashish@ethz.ch', 'niki.parmar@gmail.com'], 'Ashish Vaswani\nashish@ethz.ch\n');
    await underReview(paperId);

    const niki = await accountOf('niki@ethz.ch');
    for (const [path, body] of [
      ['/claims', { paper: PAPER, authorIndex: 2, evidence: '' }],
      ['/claims/ask', { paper: PAPER, authorIndex: 2 }],
      ['/claims/code', { paper: PAPER, authorIndex: 2, email: 'niki.parmar@gmail.com' }],
    ] as const) {
      expect((await api('POST', path, { cookie: niki.cookie, body })).status).toBe(403);
    }
    const searched = await api('GET', '/me/claim-suggestions?q=vaswani', { cookie: niki.cookie });
    expect(searched.body.papers).toEqual([]);

    const ashish = await accountOf('ashish@ethz.ch');
    expect((await claimOf(paperId, ashish.id))?.status).toBe('confirmed');
    const mine = await api('GET', '/me/claim-suggestions', { cookie: ashish.cookie });
    expect(mine.body.papers[0]).toMatchObject({ underReview: true, authors: ['Ashish Vaswani', '', ''] });
    expect((await linkedAuthors(paperId)).map((a) => a.href)).toEqual([null]);
  });
});
