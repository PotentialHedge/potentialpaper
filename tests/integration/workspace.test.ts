import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageCurrent } from '@/db/schema';
import { historyWithHandles } from '@/server/pages/edit';
import { rebuildAllPages } from '@/server/pages/projections';
import { readCommit, readFiles, readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, commitFiles, resetDatabase, signUp } from './helpers';

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

const SECTIONS = {
  'community/10-summary.md': '# Summary\nAttention replaces recurrence.\n',
  'community/20-critique.md': '# Critique\nQuadratic in length.\n\nAnd memory.\n',
  'community/30-errata.md': '# Errata\nNone yet.\n',
};

async function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani'],
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

async function fileAtHead(paperId: string, path: string): Promise<string | undefined> {
  const head = (await readHead(getDb(), paperId))!;
  const files = await readFiles(getDb(), paperId, (await readCommit(getDb(), paperId, head)).tree);
  const oid = files.get(path);
  if (!oid) return undefined;
  const res = await api('GET', `/workspace/blob?${new URLSearchParams({ ...PAPER, oid })}`);
  return (res.body as Buffer).toString('utf8');
}

async function current(paperId: string) {
  const [row] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
  return row;
}

const read = (cookie = '') => api('GET', `/workspace?${new URLSearchParams(PAPER)}`, { cookie });

/** A page with `SECTIONS` as its community section, written by Ada. */
async function started() {
  const paperId = await paper();
  const ada = await signUp('ada@ethz.ch');
  const first = await commitFiles(ada, PAPER, null, SECTIONS, 'Start the page');
  expect(first.status).toBe(200);
  return { paperId, ada, head: first.body.head as string };
}

beforeAll(() => {
  process.env.THUMBNAILS_DIR = mkdtempSync(join(tmpdir(), 'thumbnails-'));
});
afterAll(closePool);
beforeEach(resetDatabase);

describe('the web editor workspace', () => {
  it('lists the files at the head, read-only for a reader who is not signed in', async () => {
    const empty = await paper();
    const before = await read();
    expect(before.status).toBe(200);
    // A page without a repo shows the files its first commit starts with: empty sections, prek.toml.
    expect(before.body).toMatchObject({ head: null, signedIn: false });
    expect(before.body.files.map((f: { path: string }) => f.path)).toEqual(
      expect.arrayContaining(['prek.toml', 'community/10-summary.md', 'author/10-tl-dr.md']),
    );
    expect(before.body.files.find((f: { path: string }) => f.path === 'community/10-summary.md')).toMatchObject({
      text: '',
      readonly: 'sign in to edit',
    });
    expect(before.body.clone.https).toMatch(/\/git\/arxiv\/1706\.03762\.git$/);
    expect(empty).toBeTruthy();

    const { head } = await started();
    const anonymous = await read();
    expect(anonymous.body.head).toBe(head);
    const summary = anonymous.body.files.find((f: { path: string }) => f.path === 'community/10-summary.md');
    expect(summary).toMatchObject({ text: SECTIONS['community/10-summary.md'], readonly: 'sign in to edit' });
    expect(anonymous.body.files.map((f: { path: string }) => f.path)).toContain('.potentialpaper/metadata.json');

    const ada = await read(await signUp('bob@ethz.ch'));
    expect(ada.body.signedIn).toBe(true);
    const files = Object.fromEntries(ada.body.files.map((f: { path: string; readonly: string | null }) => [f.path, f]));
    expect(files['community/10-summary.md'].readonly).toBeNull();
    expect(files['.potentialpaper/metadata.json'].readonly).toMatch(/only the system and admins/);
    expect(ada.body.areas['community/']).toBeNull();
    expect(ada.body.areas['author/']).toMatch(/confirmed authors/);

    const blob = await api('GET', `/workspace/blob?${new URLSearchParams({ ...PAPER, oid: summary.oid })}`);
    expect(blob.status).toBe(200);
    expect((blob.body as Buffer).toString('utf8')).toBe(SECTIONS['community/10-summary.md']);
    expect((await api('GET', `/workspace/blob?${new URLSearchParams({ ...PAPER, oid: 'f'.repeat(40) })}`)).status).toBe(
      404,
    );
  });

  it('commits several files at once, with evidence from the message, and renders them', async () => {
    const { paperId, ada, head } = await started();
    const res = await commitFiles(
      ada,
      PAPER,
      head,
      {
        'community/30-errata.md': '# Errata\nTable 2 is wrong.\n',
        'community/40-reproductions.md': '# Reproductions\nReproduced on WMT14.\n',
        'community/20-critique.md': null,
      },
      'Fix the errata\n\nThe table was copied from v1.\n\nEvidence: https://github.com/x/y/issues/1',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, merged: false });
    const row = await current(paperId);
    expect(row.communityHtml).toContain('Table 2 is wrong.');
    expect(row.communityHtml).toContain('Reproductions');
    expect(row.communityHtml).not.toContain('Critique');
    const [last] = await historyWithHandles(paperId, { limit: 1 });
    expect(last).toMatchObject({ summary: 'Fix the errata', evidence: ['https://github.com/x/y/issues/1'] });
    await rebuildAllPages();
    expect((await current(paperId)).communityHtml).toBe(row.communityHtml);

    const trailer = await commitFiles(
      ada,
      PAPER,
      res.body.head,
      { 'community/30-errata.md': 'x' },
      'X\n\nSigned-off-by: Me',
    );
    expect(trailer.status).toBe(422);
    const blank = await commitFiles(ada, PAPER, res.body.head, { 'community/30-errata.md': '# Errata\nx\n' }, '  ');
    expect(blank.status).toBe(422);
    const same = await commitFiles(ada, PAPER, res.body.head, {
      'community/30-errata.md': '# Errata\nTable 2 is wrong.\n',
    });
    expect(same.body).toMatchObject({ changed: false });
  });

  it('merges a change made from an older head with what came since', async () => {
    const { paperId, ada, head } = await started();
    const bob = await signUp('bob@ethz.ch');
    expect(
      (await commitFiles(ada, PAPER, head, { 'community/10-summary.md': '# Summary\nAttention is enough.\n' })).status,
    ).toBe(200);
    const late = await commitFiles(bob, PAPER, head, { 'community/30-errata.md': '# Errata\nA typo in eq. 1.\n' });
    expect(late.status).toBe(200);
    expect(late.body.merged).toBe(true);
    expect(await fileAtHead(paperId, 'community/10-summary.md')).toContain('Attention is enough.');
    expect(await fileAtHead(paperId, 'community/30-errata.md')).toContain('A typo in eq. 1.');
  });

  it('answers a conflict with 409, then moves the change onto the head with conflict markers', async () => {
    const { paperId, ada, head } = await started();
    const bob = await signUp('bob@ethz.ch');
    await commitFiles(ada, PAPER, head, {
      'community/20-critique.md': '# Critique\nIt is quadratic.\n\nAnd memory.\n',
    });
    const changes = { 'community/20-critique.md': '# Critique\nQuadratic, so slow.\n\nAnd memory.\n' };
    const conflict = await commitFiles(bob, PAPER, head, changes);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('edit_conflict');

    const rebased = await api('POST', '/workspace/rebase', {
      cookie: bob,
      body: {
        paper: PAPER,
        baseOid: head,
        changes: [{ path: 'community/20-critique.md', content: changes['community/20-critique.md'] }],
      },
    });
    expect(rebased.status).toBe(200);
    const [file] = rebased.body.files;
    expect(file).toMatchObject({ path: 'community/20-critique.md', conflict: true });
    expect(file.original).toBe('# Critique\nIt is quadratic.\n\nAnd memory.\n');
    expect(file.content).toBe(
      '# Critique\n<<<<<<< your change\nQuadratic, so slow.\n=======\nIt is quadratic.\n>>>>>>> the page now\n\nAnd memory.\n',
    );

    const settled = await commitFiles(bob, PAPER, rebased.body.head, {
      'community/20-critique.md': '# Critique\nQuadratic, so slow.\n\nAnd memory.\n',
    });
    expect(settled.status).toBe(200);
    expect(settled.body.merged).toBe(false);
    expect(await fileAtHead(paperId, 'community/20-critique.md')).toContain('Quadratic, so slow.');
  });

  it('holds commits to the rules: who may write what, and a confirmed address', async () => {
    const { ada, head } = await started();
    const author = await commitFiles(ada, PAPER, head, { 'author/10-overview.md': '# Overview\nMine.\n' });
    expect(author.status).toBe(403);
    expect(author.body.error.message).toMatch(/confirmed authors/);
    const nowhere = await commitFiles(ada, PAPER, head, { 'notes.txt': 'hello' });
    expect(nowhere.status).toBe(403);
    expect((await commitFiles('', PAPER, head, { 'community/10-summary.md': 'x' })).status).toBe(401);

    const me = await api('GET', '/me', { cookie: ada });
    await getDb().update(accounts).set({ verifiedAt: null }).where(eq(accounts.handle, me.body.handle));
    expect((await commitFiles(ada, PAPER, head, { 'community/10-summary.md': '# Summary\nx\n' })).status).toBe(403);
  });

  it('stores a picture for its Git LFS path and gives the pointer to commit', async () => {
    const { paperId, ada, head } = await started();
    const form = new FormData();
    form.set('scheme', PAPER.scheme);
    form.set('value', PAPER.value);
    form.set('path', 'thumbnail.png');
    form.set('file', new Blob([PNG]), 'thumbnail.png');
    const stored = await api('POST', '/workspace/files', { cookie: ada, form });
    expect(stored.status).toBe(201);
    expect(stored.body.pointer).toMatch(
      /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:[0-9a-f]{64}\nsize 33\n$/,
    );

    const res = await commitFiles(ada, PAPER, head, { 'thumbnail.png': stored.body.pointer }, 'Add a picture');
    expect(res.status).toBe(200);
    expect((await current(paperId)).thumbnail).toMatchObject({ sha256: stored.body.sha256 });
    const listed = (await read(ada)).body.files.find((f: { path: string }) => f.path === 'thumbnail.png');
    expect(listed.lfs).toMatchObject({ sha256: stored.body.sha256, bytes: 33 });
    expect(listed.text).toBeUndefined();

    const notLfs = new FormData();
    for (const [k, v] of [...form.entries()]) notLfs.set(k, v);
    notLfs.set('path', 'community/10-summary.md');
    expect((await api('POST', '/workspace/files', { cookie: ada, form: notLfs })).status).toBe(422);
  });

  it('previews through the same renderer, with HTML neutralised', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const res = await api('POST', '/pages/render', {
      cookie,
      body: { content: '# A\n<script>x</script> [a](javascript:alert(1)) $x$' },
    });
    expect(res.status).toBe(200);
    expect(res.body.html).toContain('&lt;script&gt;');
    expect(res.body.html).not.toContain('href=');
    expect(res.body.html).toContain('katex');
    expect((await api('POST', '/pages/render', { body: { content: 'x' } })).status).toBe(401);
  });
});

describe('history and revert', () => {
  it('reverts one commit and keeps the later ones', async () => {
    const { paperId, ada, head } = await started();
    const bad = await commitFiles(
      ada,
      PAPER,
      head,
      { 'community/10-summary.md': '# Summary\nVandalism.\n' },
      'Vandalise',
    );
    const good = await commitFiles(ada, PAPER, bad.body.head, { 'community/30-errata.md': '# Errata\nFixed.\n' });
    const res = await api('POST', '/pages/revert', { cookie: ada, body: { paper: PAPER, oid: bad.body.head } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    const text = (await current(paperId)).communityMarkdown;
    expect(text).toContain('Attention replaces recurrence.');
    expect(text).toContain('Fixed.');
    expect(good.status).toBe(200);
    const [last] = await historyWithHandles(paperId, { limit: 1 });
    expect(last).toMatchObject({ kind: 'revert', summary: 'Revert "Vandalise"' });
    expect(
      (await api('POST', '/pages/revert', { cookie: ada, body: { paper: PAPER, oid: 'f'.repeat(40) } })).status,
    ).toBe(404);
  });

  it('names handles, never account ids', async () => {
    const { paperId } = await started();
    const history = await historyWithHandles(paperId);
    const [account] = await getDb().select().from(accounts);
    expect(history.map((h) => h.handle)).toEqual([account.handle]);
    const json = JSON.stringify(history);
    expect(json).not.toContain(account.id);
    expect(json).not.toMatch(/accountId|account_id/);
    expect(Object.keys(history[0]).sort()).toEqual(
      [
        'at',
        'authorId',
        'authorName',
        'bytesDelta',
        'evidence',
        'handle',
        'kind',
        'oid',
        'paths',
        'seq',
        'summary',
      ].sort(),
    );
  });
});
