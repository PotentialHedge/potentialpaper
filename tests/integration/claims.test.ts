import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, commitIdentities, pageCurrent, pageObjects } from '@/db/schema';
import { decideClaim } from '@/server/claims';
import { setThumbnail } from '@/server/pages/card';
import { historyWithHandles } from '@/server/pages/edit';
import { savePaper } from '@/server/papers';
import { api, closePool, resetDatabase, signUp } from './helpers';

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

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
  api('POST', '/pages/edit', {
    cookie,
    body: { paper: PAPER, part: 'author', baseOid, section: 0, content, summary: '' },
  });

let images: string;
beforeAll(() => {
  images = mkdtempSync(join(tmpdir(), 'thumbnails-'));
  process.env.THUMBNAILS_DIR = images;
});
afterAll(async () => {
  rmSync(images, { recursive: true, force: true });
  await closePool();
});
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
    expect((await authorEdit(ashish.cookie, '## TL;DR\nAttention.\n')).status).toBe(403);

    const [row] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
    expect(row.identityId).toMatch(/^a_[a-z0-9]{8}$/);
    await decideClaim(row.id, 'confirmed', null);

    const written = await authorEdit(ashish.cookie, '## TL;DR\nAttention.\n');
    expect(written.status).toBe(200);
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(current.authorHtml).toContain('Attention.');

    // Everything they do on their own paper is under the per-claim id, never their handle.
    const community = await api('POST', '/pages/edit', {
      cookie: ashish.cookie,
      body: { paper: PAPER, baseOid: written.body.head, section: 0, content: '## Errata\nNone.\n', summary: '' },
    });
    expect(community.status).toBe(200);
    const history = await historyWithHandles(paperId);
    for (const entry of history.slice(0, 2)) {
      expect(entry).toMatchObject({ authorId: row.identityId, authorName: 'Ashish Vaswani', handle: null });
    }
    // Nothing in the repo, which anyone can clone, carries the account's own u_ id.
    const objects = await getDb().select().from(pageObjects).where(eq(pageObjects.paperId, paperId));
    const repo = objects.map((o) => o.body.toString('latin1')).join('\n');
    const [identity] = await getDb()
      .select({ id: commitIdentities.id })
      .from(commitIdentities)
      .where(eq(commitIdentities.accountId, ashish.account.id));
    if (identity) expect(repo).not.toContain(identity.id);
    expect(repo).toContain(row.identityId);
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

describe("a paper's picture and links", () => {
  it('are anyone verified until the paper is claimed, then its authors only', async () => {
    const paperId = await paper();
    const ada = await accountOf('ada@ethz.ch');
    const ashish = await accountOf('ashish@ethz.ch');

    const links = await api('POST', '/pages/links', {
      cookie: ada.cookie,
      body: {
        paper: PAPER,
        links: [
          { label: 'Code', url: 'https://github.com/tensorflow/tensor2tensor' },
          { label: 'PDF', url: 'https://example.org/attention.pdf' },
        ],
      },
    });
    expect(links.status).toBe(200);
    const bad = await api('POST', '/pages/links', {
      cookie: ada.cookie,
      body: { paper: PAPER, links: [{ label: 'X', url: 'javascript:alert(1)' }] },
    });
    expect(bad.status).toBe(422);

    const actor = { kind: 'account' as const, accountId: ada.account.id, isAdmin: false };
    const picture = await setThumbnail(paperId, actor, { image: PNG, alt: 'One pixel' });
    expect(picture.status).toBe('committed');
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(current.links).toEqual([
      { label: 'Code', url: 'https://github.com/tensorflow/tensor2tensor' },
      { label: 'PDF', url: 'https://example.org/attention.pdf' },
    ]);
    expect(current.thumbnail).toMatchObject({ type: 'image/png', alt: 'One pixel', url: /^\/thumbnails\// });
    // New words keep the image.
    await setThumbnail(paperId, actor, { caption: 'A pixel.' });
    const [worded] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(worded.thumbnail).toMatchObject({ sha256: current.thumbnail!.sha256, caption: 'A pixel.' });

    await api('POST', '/claims', { cookie: ashish.cookie, body: { paper: PAPER, authorIndex: 0 } });
    const [claim] = await getDb().select().from(authorClaims);
    await decideClaim(claim.id, 'confirmed', null);

    const denied = await api('POST', '/pages/links', { cookie: ada.cookie, body: { paper: PAPER, links: [] } });
    expect(denied.status).toBe(403);
    await expect(setThumbnail(paperId, actor, { caption: 'Mine now' })).rejects.toMatchObject({ status: 403 });
    const allowed = await api('POST', '/pages/links', { cookie: ashish.cookie, body: { paper: PAPER, links: [] } });
    expect(allowed.status).toBe(200);
  });
});
