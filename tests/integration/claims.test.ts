import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, commitIdentities, pageCurrent, pageObjects } from '@/db/schema';
import { decideClaim } from '@/server/claims';
import { historyWithHandles } from '@/server/pages/edit';
import { savePaper } from '@/server/papers';
import { api, closePool, commitFiles, resetDatabase, signUp } from './helpers';

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

async function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

async function accountOf(email: string) {
  const cookie = await signUp(email);
  const me = await api('GET', '/me', { cookie });
  const [account] = await getDb().select().from(accounts).where(eq(accounts.id, me.body.id));
  return { cookie, account };
}

const authorEdit = (cookie: string, content: string, baseOid: string | null = null) =>
  commitFiles(cookie, PAPER, baseOid, { 'owners/10-tldr.md': content });

afterAll(closePool);
beforeEach(resetDatabase);

describe('claiming a paper', () => {
  it('is pending until an admin confirms it, then the author writes under the name on the paper', async () => {
    const paperId = await paper();
    const ashish = await accountOf('ashish@ethz.ch');

    const claim = await api('POST', '/claims', {
      cookie: ashish.cookie,
      body: { paper: PAPER, authorIndex: 0, evidence: 'My address is on the first page.' },
    });
    expect(claim.status).toBe(201);
    expect(claim.body.claim).toMatchObject({ authorName: 'Ashish Vaswani', status: 'pending' });

    // Pending grants nothing.
    expect((await authorEdit(ashish.cookie, '# TL;DR\nAttention.\n')).status).toBe(403);

    const [row] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
    expect(row.identityId).toMatch(/^a_[a-z0-9]{8}$/);
    await decideClaim(row.id, 'confirmed', null);

    const written = await authorEdit(ashish.cookie, '# TL;DR\nAttention.\n');
    expect(written.status).toBe(200);
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(current.authorHtml).toContain('Attention.');

    // Everything they do on their own paper is under the per-claim id, never their handle.
    const community = await commitFiles(ashish.cookie, PAPER, written.body.head, {
      'community/10-errata.md': '# Errata\nNone.\n',
    });
    expect(community.status).toBe(200);
    const history = await historyWithHandles(paperId);
    for (const entry of history.slice(0, 2)) {
      expect(entry).toMatchObject({ authorId: row.identityId, authorName: 'Ashish Vaswani', handle: null });
    }
    // Nothing in the repo, which anyone can clone, carries the account's own u_ id.
    const objects = await getDb().select().from(pageObjects).where(eq(pageObjects.pageId, paperId));
    const repo = objects.map((o) => o.body.toString('latin1')).join('\n');
    const [identity] = await getDb()
      .select({ id: commitIdentities.id })
      .from(commitIdentities)
      .where(eq(commitIdentities.accountId, ashish.account.id));
    if (identity) expect(repo).not.toContain(identity.id);
    expect(repo).toContain(row.identityId);
  });

  it("lets only a confirmed author list plugins' panels for the author section", async () => {
    const paperId = await paper();
    const ashish = await accountOf('ashish@ethz.ch');
    const other = await accountOf('noam@ethz.ch');
    await api('POST', '/claims', {
      cookie: ashish.cookie,
      body: { paper: PAPER, authorIndex: 0, evidence: 'My address is on the first page.' },
    });
    const [row] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
    await decideClaim(row.id, 'confirmed', null);

    const file = { 'owners/plugins.json': '{ "panels": [{ "panel": "o/map.minimap", "settings": { "zoom": 2 } }] }\n' };
    expect((await commitFiles(other.cookie, PAPER, null, file)).status).toBe(403);
    expect(
      (await commitFiles(ashish.cookie, PAPER, null, { 'owners/plugins.json': '{ "panels": [{ "panel": "x" }] }' }))
        .status,
    ).toBe(422);
    const written = await commitFiles(ashish.cookie, PAPER, null, file);
    expect(written.status).toBe(200);
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, paperId));
    expect(current.authorPlugins).toEqual([{ panel: 'o/map.minimap', settings: { zoom: 2 } }]);
  });

  it('can be changed or withdrawn while pending, and not taken from a confirmed author', async () => {
    const paperId = await paper();
    const ashish = await accountOf('ashish@ethz.ch');
    const noam = await accountOf('noam@ethz.ch');
    await api('POST', '/claims', { cookie: ashish.cookie, body: { paper: PAPER, authorIndex: 1 } });
    const changed = await api('POST', '/claims', { cookie: ashish.cookie, body: { paper: PAPER, authorIndex: 0 } });
    expect(changed.body.claim.authorName).toBe('Ashish Vaswani');
    const [row] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
    await decideClaim(row.id, 'confirmed', null);

    const taken = await api('POST', '/claims', { cookie: noam.cookie, body: { paper: PAPER, authorIndex: 0 } });
    expect(taken.status).toBe(409);
    expect((await api('POST', '/claims', { cookie: noam.cookie, body: { paper: PAPER, authorIndex: 5 } })).status).toBe(
      422,
    );
    await api('POST', '/claims', { cookie: noam.cookie, body: { paper: PAPER, authorIndex: 1 } });
    const query = new URLSearchParams(PAPER);
    expect((await api('DELETE', `/claims?${query}`, { cookie: noam.cookie })).status).toBe(200);
    expect((await api('GET', `/claims?${query}`, { cookie: noam.cookie })).body.claim).toBeNull();
    // A decided claim stays.
    expect((await api('DELETE', `/claims?${query}`, { cookie: ashish.cookie })).status).toBe(404);
  });
});

describe('My papers and co-authors', () => {
  async function confirmedAshish(paperId: string) {
    const ashish = await accountOf('ashish@ethz.ch');
    await api('POST', '/claims', { cookie: ashish.cookie, body: { paper: PAPER, authorIndex: 0, evidence: '' } });
    const [row] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
    await decideClaim(row.id, 'confirmed', null);
    return ashish;
  }

  it('lists the papers an account has claimed, and lets a confirmed author add a co-author by handle', async () => {
    const paperId = await paper();
    const ashish = await confirmedAshish(paperId);
    const noam = await accountOf('noam@ethz.ch');

    const mine = await api('GET', '/me/papers', { cookie: ashish.cookie });
    expect(mine.status).toBe(200);
    expect(mine.body.authored).toEqual([
      expect.objectContaining({
        title: 'Attention Is All You Need',
        paper: PAPER,
        path: expect.stringMatching(/^\/s\/\d+$/),
        mine: expect.objectContaining({ authorName: 'Ashish Vaswani', status: 'confirmed' }),
        confirmed: [{ authorIndex: 0, authorName: 'Ashish Vaswani' }],
        waiting: [],
      }),
    ]);
    expect((await api('GET', '/me/papers', { cookie: noam.cookie })).body.authored).toEqual([]);

    // Only a confirmed author may vouch.
    const refused = await api('POST', '/me/papers/co-authors', {
      cookie: noam.cookie,
      body: { paper: PAPER, handle: ashish.account.handle, authorIndex: 1 },
    });
    expect(refused.status).toBe(403);

    // Not as an author someone is already confirmed as.
    const taken = await api('POST', '/me/papers/co-authors', {
      cookie: ashish.cookie,
      body: { paper: PAPER, handle: `@${noam.account.handle}`, authorIndex: 0 },
    });
    expect(taken.status).toBe(409);

    const added = await api('POST', '/me/papers/co-authors', {
      cookie: ashish.cookie,
      body: { paper: PAPER, handle: `@${noam.account.handle}`, authorIndex: 1 },
    });
    expect(added.status).toBe(201);
    expect(added.body).toEqual({ authorIndex: 1, authorName: 'Noam Shazeer' });
    const [claim] = await getDb().select().from(authorClaims).where(eq(authorClaims.accountId, noam.account.id));
    expect(claim).toMatchObject({ status: 'confirmed', method: 'vouch', decidedBy: ashish.account.id });

    // They can step down, and aren't added again over that.
    expect((await api('DELETE', `/claims?scheme=arxiv&value=1706.03762`, { cookie: noam.cookie })).status).toBe(200);
    const again = await api('POST', '/me/papers/co-authors', {
      cookie: ashish.cookie,
      body: { paper: PAPER, handle: noam.account.handle, authorIndex: 1 },
    });
    expect(again.status).toBe(409);
  });

  it("shows a co-author's pending claim to the paper's confirmed authors, who can confirm it", async () => {
    const paperId = await paper();
    const ashish = await confirmedAshish(paperId);
    const noam = await accountOf('noam@ethz.ch');
    await api('POST', '/claims', {
      cookie: noam.cookie,
      body: { paper: PAPER, authorIndex: 1, evidence: 'Ask Ashish.' },
    });

    const mine = await api('GET', '/me/papers', { cookie: ashish.cookie });
    const [waiting] = mine.body.authored[0].waiting;
    expect(waiting).toMatchObject({ authorName: 'Noam Shazeer', evidence: 'Ask Ashish.' });
    // Their own view shows it pending, and nothing waiting on others.
    const theirs = await api('GET', '/me/papers', { cookie: noam.cookie });
    expect(theirs.body.authored[0]).toMatchObject({ mine: { status: 'pending' }, waiting: [] });

    const confirmed = await api('POST', '/me/papers/co-authors', {
      cookie: ashish.cookie,
      body: { paper: PAPER, claim: waiting.claim },
    });
    expect(confirmed.status).toBe(201);
    const after = await api('GET', '/me/papers', { cookie: noam.cookie });
    expect(after.body.authored[0].mine).toMatchObject({ status: 'confirmed', method: 'vouch', canStepDown: true });
  });
});

describe('what the web editor says each viewer may change', () => {
  const areas = async (cookie: string) =>
    (await api('GET', `/workspace?${new URLSearchParams(PAPER)}`, { cookie })).body.areas;

  it('follows the rules the commit enforces', async () => {
    await paper();
    const ada = await accountOf('ada@ethz.ch');
    const ashish = await accountOf('ashish@ethz.ch');

    expect((await areas(''))['community/']).toBe('sign in to edit');
    expect(await areas(ada.cookie)).toMatchObject({ 'community/': null, 'thumbnail.json': null, 'links/': null });
    expect((await areas(ada.cookie))['owners/']).toMatch(/confirmed authors/);

    await api('POST', '/claims', { cookie: ashish.cookie, body: { paper: PAPER, authorIndex: 0 } });
    const [claim] = await getDb().select().from(authorClaims);
    await decideClaim(claim.id, 'confirmed', null);
    expect((await areas(ada.cookie))['links/']).toMatch(/confirmed authors/);
    expect(await areas(ashish.cookie)).toMatchObject({ 'owners/': null, 'links/': null, 'thumbnail.json': null });

    await getDb().update(accounts).set({ verifiedAt: null }).where(eq(accounts.id, ada.account.id));
    expect((await areas(ada.cookie))['community/']).toMatch(/institutional email/);
  });
});
