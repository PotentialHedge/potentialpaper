import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageCurrent } from '@/db/schema';
import { commitPage } from '@/server/pages/commit';
import { editorState, historyWithHandles } from '@/server/pages/edit';
import { rebuildAllPages } from '@/server/pages/projections';
import { readCommit, readFiles, readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, resetDatabase, signUp } from './helpers';

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

const PAGE = `# Summary
Attention replaces recurrence.

# Critique
Quadratic in length.

# Errata
None yet.
`;

/** The part as an agent reads it: the files joined, each `#` under the part's own heading. */
const forAgents = (text: string) => text.replace(/^# /gm, '### ');

async function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: [],
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

async function paths(paperId: string): Promise<string[]> {
  const head = (await readHead(getDb(), paperId))!;
  const files = await readFiles(getDb(), paperId, (await readCommit(getDb(), paperId, head)).tree);
  return [...files.keys()].sort();
}

async function current(paperId: string) {
  const [row] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
  return row;
}

function edit(cookie: string, body: { baseOid: string | null; section: number; content: string; summary?: string }) {
  return api('POST', '/pages/edit', { cookie, body: { paper: PAPER, summary: '', ...body } });
}

/** A page with `PAGE` as its community section, written by Ada. */
async function started() {
  const paperId = await paper();
  const ada = await signUp('ada@ethz.ch');
  const first = await edit(ada, { baseOid: null, section: 0, content: PAGE, summary: 'Start the page' });
  expect(first.status).toBe(200);
  return { paperId, ada, head: first.body.head as string };
}

afterAll(closePool);
beforeEach(resetDatabase);

describe('editing the community section', () => {
  it('starts an empty page from the starter headings, then commits and renders it', async () => {
    const paperId = await paper();
    const state = await editorState(paperId, 'community', 0);
    expect(state).toMatchObject({ baseOid: null, section: 0, starter: true });
    expect(state?.text).toMatch(/^# Summary\n\n# Why it matters\n/);
    expect(await editorState(paperId, 'community', 1)).toBeNull();

    const ada = await signUp('ada@ethz.ch');
    const res = await edit(ada, { baseOid: null, section: 0, content: state!.text });
    expect(res.status).toBe(200);
    expect(res.body.head).toMatch(/^[0-9a-f]{40}$/);
    expect((await editorState(paperId, 'community', 6))?.title).toBe('Follow-ups');
    expect((await paths(paperId)).filter((p) => p.startsWith('community/'))).toEqual([
      'community/10-summary.md',
      'community/20-why-it-matters.md',
      'community/30-critique.md',
      'community/40-errata.md',
      'community/50-reproductions.md',
      'community/60-follow-ups.md',
    ]);
  });

  it('stores the rendered HTML, which survives a rebuild', async () => {
    const { paperId } = await started();
    const row = await current(paperId);
    expect(row.communityMarkdown).toBe(forAgents(PAGE));
    expect(row.communityHtml).toContain('<h3 id="community-2" data-section="2">Critique</h3>');
    await rebuildAllPages();
    expect((await current(paperId)).communityHtml).toBe(row.communityHtml);
  });

  it('replaces one section and leaves the others alone', async () => {
    const { paperId, ada, head } = await started();
    const state = await editorState(paperId, 'community', 2);
    expect(state).toMatchObject({
      baseOid: head,
      title: 'Critique',
      path: 'community/20-critique.md',
      format: 'markdown',
      text: '# Critique\nQuadratic in length.\n',
    });
    const res = await edit(ada, { baseOid: head, section: 2, content: '# Critique\nQuadratic, but parallel.\n' });
    expect(res.body).toMatchObject({ changed: true, merged: false });
    expect((await current(paperId)).communityMarkdown).toBe(
      forAgents(PAGE.replace('Quadratic in length.', 'Quadratic, but parallel.')),
    );
    const [last] = await historyWithHandles(paperId, { limit: 1 });
    expect(last.paths).toEqual(['community/20-critique.md']);
    expect((await edit(ada, { baseOid: head, section: 9, content: 'x' })).status).toBe(422);
  });

  it('merges two people editing different sections from the same version', async () => {
    const { paperId, ada, head } = await started();
    const bob = await signUp('bob@ethz.ch');
    const one = await edit(ada, { baseOid: head, section: 1, content: '# Summary\nAttention is enough.\n' });
    const two = await edit(bob, { baseOid: head, section: 3, content: '# Errata\nEq. 1 lacks a square root.\n' });
    expect(one.body.merged).toBe(false);
    expect(two.status).toBe(200);
    expect(two.body.merged).toBe(true);
    expect((await current(paperId)).communityMarkdown).toBe(
      forAgents(
        PAGE.replace('Attention replaces recurrence.', 'Attention is enough.').replace(
          'None yet.',
          'Eq. 1 lacks a square root.',
        ),
      ),
    );
  });

  it('answers a real conflict with 409, every version, and the section as it is now', async () => {
    const { paperId, ada, head } = await started();
    const bob = await signUp('bob@ethz.ch');
    await edit(ada, { baseOid: head, section: 2, content: '# Critique\nAda says so.\n' });
    const clash = await edit(bob, { baseOid: head, section: 2, content: '# Critique\nBob says otherwise.\n' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('edit_conflict');
    const [conflict] = clash.body.error.details.conflicts;
    expect(conflict.path).toBe('community/20-critique.md');
    expect(conflict.base).toBe('# Critique\nQuadratic in length.\n');
    expect(conflict.ours).toContain('Bob says otherwise.');
    expect(conflict.theirs).toContain('Ada says so.');
    const now = await readHead(getDb(), paperId);
    expect(clash.body.error.details.current).toEqual({ head: now, section: 2, text: '# Critique\nAda says so.\n' });

    // Saved again against what the conflict showed, it goes in.
    const retry = await edit(bob, { baseOid: now, section: 2, content: '# Critique\nAda and Bob disagree.\n' });
    expect(retry.status).toBe(200);
    expect((await current(paperId)).communityMarkdown).toContain('Ada and Bob disagree.');
  });

  it('makes a file for a new heading, after its neighbour, and removes an emptied section', async () => {
    const { paperId, ada, head } = await started();
    const res = await edit(ada, {
      baseOid: head,
      section: 1,
      content: '# Summary\nAttention replaces recurrence.\n\n# Why it matters\nSpeed.\n',
    });
    expect(res.status).toBe(200);
    const gone = await edit(ada, { baseOid: res.body.head, section: 4, content: '' });
    expect(gone.status).toBe(200);
    expect(await paths(paperId)).toEqual([
      '.potentialpaper/metadata.json',
      'community/10-summary.md',
      'community/15-why-it-matters.md',
      'community/20-critique.md',
    ]);
    expect((await editorState(paperId, 'community', 2))?.title).toBe('Why it matters');
  });

  it('edits an HTML section as HTML, refusing what the allowlist does not have', async () => {
    const { paperId, ada, head } = await started();
    const admin = { kind: 'account' as const, accountId: (await getDb().select().from(accounts))[0].id, isAdmin: true };
    const html = await commitPage(
      paperId,
      head,
      admin,
      [{ path: 'community/25-figure.html', content: '<h1>Figure</h1>\n<p>A <b>table</b>.</p>\n' }],
      'Add a figure',
    );
    expect((await current(paperId)).communityHtml).toContain(
      '<h3 id="community-3" data-section="3">Figure</h3>\n<p>A <b>table</b>.</p>',
    );
    const state = await editorState(paperId, 'community', 3);
    expect(state).toMatchObject({ title: 'Figure', format: 'html', path: 'community/25-figure.html' });
    const bad = await edit(ada, { baseOid: html.oid, section: 3, content: '<h1>Figure</h1><script>x</script>' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/<script>/);
    const good = await edit(ada, {
      baseOid: html.oid,
      section: 3,
      content: '<h1>Figure</h1>\n<p># Not a heading</p>\n',
    });
    expect(good.status).toBe(200);
    expect((await paths(paperId)).filter((p) => p.endsWith('.html'))).toEqual(['community/25-figure.html']);
    // The whole part is one Markdown text, which an HTML section can't be part of.
    await expect(editorState(paperId, 'community', 0)).rejects.toMatchObject({ status: 422 });
    expect((await edit(ada, { baseOid: good.body.head, section: 0, content: 'x' })).status).toBe(422);
    const preview = await api('POST', '/pages/render', {
      cookie: ada,
      body: { content: '<h1>A</h1><p onclick="x()">b</p>', format: 'html' },
    });
    expect(preview.body.html).toBe('<h3>A</h3><p>b</p>');
  });

  it('needs a confirmed institutional address', async () => {
    await paper();
    const cookie = await signUp('eve@ethz.ch');
    const me = await api('GET', '/me', { cookie });
    await getDb().update(accounts).set({ verifiedAt: null }).where(eq(accounts.handle, me.body.handle));
    const res = await edit(cookie, { baseOid: null, section: 0, content: 'Hello' });
    expect(res.status).toBe(403);
    expect((await edit('', { baseOid: null, section: 0, content: 'Hello' })).status).toBe(401);
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
    const bad = await edit(ada, { baseOid: head, section: 1, content: '# Summary\nVandalism.\n' });
    const good = await edit(ada, { baseOid: bad.body.head, section: 3, content: '# Errata\nFixed.\n' });
    const res = await api('POST', '/pages/revert', { cookie: ada, body: { paper: PAPER, oid: bad.body.head } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    const text = (await current(paperId)).communityMarkdown;
    expect(text).toContain('Attention replaces recurrence.');
    expect(text).toContain('Fixed.');
    expect(good.status).toBe(200);
    const [last] = await historyWithHandles(paperId, { limit: 1 });
    expect(last).toMatchObject({ kind: 'revert', summary: 'Revert "Edit “Summary”"' });
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
