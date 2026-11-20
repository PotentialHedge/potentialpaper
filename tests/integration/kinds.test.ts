import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as gitRoute from '@/app/git/[...path]/route';
import { getDb } from '@/db';
import { accounts, pageCurrent, pages, papers } from '@/db/schema';
import { ensureBot, grantBot } from '@/server/bots';
import { pageClonePath } from '@/server/pages/clone';
import { commitPage, createPage } from '@/server/pages/commit';
import { findPage } from '@/server/pages/kinds';
import { gitIdentity } from '@/server/pages/receive';
import { readFiles, readCommit, readHead, readText } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { mintToken } from '@/server/tokens';
import { closePool, resetDatabase } from './helpers';

/**
 * Pages of kinds other than a paper (`handoffs/pages.md` Phase 1): made by `createPage`, written under their own
 * path rules, and cloned and pushed with stock git like a paper's.
 */

beforeEach(resetDatabase);
afterAll(closePool);

let count = 0;

async function person(fields: Partial<typeof accounts.$inferInsert> = {}) {
  count += 1;
  const [account] = await getDb()
    .insert(accounts)
    .values({ handle: `person-${count}`, verifiedAt: new Date(), ...fields })
    .returning();
  return { actor: { kind: 'account', accountId: account.id, isAdmin: false } as const, account };
}

async function files(pageId: string): Promise<Record<string, string>> {
  const head = await readHead(getDb(), pageId);
  const commit = await readCommit(getDb(), pageId, head!);
  const out: Record<string, string> = {};
  for (const [path, blob] of await readFiles(getDb(), pageId, commit.tree)) {
    out[path] = (await readText(getDb(), pageId, blob)) ?? '';
  }
  return out;
}

describe('pages', () => {
  it('gives every paper a page with its id, made and deleted with it', async () => {
    const paperId = await savePaper({
      title: 'A paper',
      authors: [],
      abstract: null,
      year: 2024,
      venue: null,
      source: 'arxiv',
      metadataLicense: 'CC0-1.0',
      abstractLicense: null,
      identifiers: [{ scheme: 'arxiv', value: '2401.00001' }],
    });
    expect(await getDb().select().from(pages).where(eq(pages.id, paperId))).toMatchObject([
      { kind: 'paper', key: paperId },
    ]);
    expect(await findPage('arxiv:2401.00001')).toMatchObject({ id: paperId, kind: 'paper' });
    await getDb().delete(papers).where(eq(papers.id, paperId));
    expect(await getDb().select().from(pages).where(eq(pages.id, paperId))).toEqual([]);
  });

  it('makes a page of another kind once, with its repo started by the system', async () => {
    const venue = await createPage('venue', 'iclr/2027');
    expect(await createPage('venue', 'iclr/2027')).toEqual(venue);
    expect(await findPage('venue:iclr/2027')).toMatchObject({ id: venue.id, kind: 'venue', key: 'iclr/2027' });
    const tree = await files(venue.id);
    expect(Object.keys(tree).sort()).toEqual(['.gitattributes', '.potentialpaper/metadata.json', 'prek.toml']);
    expect(JSON.parse(tree['.potentialpaper/metadata.json'])).toEqual({ layout: 4, kind: 'venue', key: 'iclr/2027' });
    await expect(createPage('venue', 'ICLR 2027')).rejects.toThrow(/slugs/);
    await expect(createPage('topic', 'a/b')).rejects.toThrow(/more than 1 part/);
    await expect(createPage('user', 'x')).rejects.toThrow(/handle/);
  });
});

describe('path rules per kind', () => {
  it('lets anyone verified write a topic, and nobody unverified', async () => {
    const topic = await createPage('topic', 'linear-attention');
    const { actor } = await person();
    const result = await commitPage(
      topic.id,
      topic.head,
      actor,
      [
        { path: 'topic.json', content: '{ "name": "Linear attention", "aliases": ["Linear transformers"] }\n' },
        { path: 'community/10-what-it-is.md', content: '# What it is\n\nAttention in linear time.\n' },
        {
          path: 'community/links.jsonl',
          content: '{"id":"l1","to":"topic:efficient-transformers","label":"related"}\n',
        },
      ],
      'Start the topic',
    );
    expect(result.status).toBe('committed');
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.pageId, topic.id));
    expect(current.communityHtml).toContain('Attention in linear time.');
    expect(current.authorHtml).toBeNull();

    const { actor: unverified } = await person({ verifiedAt: null });
    await expect(
      commitPage(topic.id, null, unverified, [{ path: 'community/20-x.md', content: 'x\n' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
    // A topic has no owners' part, and no paper's files.
    await expect(
      commitPage(topic.id, null, actor, [{ path: 'owners/10-x.md', content: 'x\n' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      commitPage(topic.id, null, actor, [{ path: 'versions/v_k3x9q2ab.json', content: '{}' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      commitPage(topic.id, null, actor, [{ path: 'topic.json', content: '{ "title": "x" }' }], 'x'),
    ).rejects.toMatchObject({ status: 422, message: expect.stringContaining('topic.json') });
  });

  it("keeps a venue's organisers' part and kind file to its owners and the bot granted it", async () => {
    const venue = await createPage('venue', 'neurips');
    const { actor } = await person();
    await expect(
      commitPage(venue.id, null, actor, [{ path: 'owners/10-welcome.md', content: 'Hi\n' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      commitPage(venue.id, null, actor, [{ path: 'venue.json', content: '{ "name": "NeurIPS" }\n' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await commitPage(venue.id, null, actor, [{ path: 'community/10-notes.md', content: 'Notes\n' }], 'x')).status,
    ).toBe('committed');

    const bot = await ensureBot('venues');
    // A grant is per kind: a paper's folder can't be granted on venues, nor a venue's file on papers.
    await expect(grantBot('venues', 'reviews/openreview/**', { grantedBy: 'admin', kind: 'venue' })).rejects.toThrow();
    await expect(grantBot('venues', 'venue.json', { grantedBy: 'admin' })).rejects.toThrow();
    await grantBot('venues', 'venue.json', { grantedBy: 'admin', kind: 'venue' });
    const content = '{ "name": "NeurIPS", "sources": ["openreview:NeurIPS.cc/2026/Conference"] }\n';
    expect((await commitPage(venue.id, null, bot, [{ path: 'venue.json', content }], 'Sources')).status).toBe(
      'committed',
    );
    await expect(
      commitPage(venue.id, null, bot, [{ path: 'community/20-x.md', content: 'x\n' }], 'x'),
    ).resolves.toMatchObject({ status: 'committed' });
    await expect(
      commitPage(venue.id, null, { ...actor, isAdmin: true }, [{ path: 'owners/10-a.md', content: 'A\n' }], 'x'),
    ).resolves.toMatchObject({ status: 'committed' });
  });

  it('lets only its account write a user page', async () => {
    const { actor, account } = await person();
    const page = await createPage('user', account.handle);
    const { actor: other } = await person();
    await expect(
      commitPage(page.id, null, other, [{ path: 'owners/10-me.md', content: 'Not me\n' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      commitPage(page.id, null, actor, [{ path: 'community/10-me.md', content: 'x\n' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
    const links = '{"id":"a","to":"arxiv:1706.03762","label":"related"}\n';
    expect(
      (
        await commitPage(
          page.id,
          null,
          actor,
          [
            { path: 'owners/10-me.md', content: 'Me\n' },
            { path: 'owners/links.jsonl', content: links },
          ],
          'About me',
        )
      ).status,
    ).toBe('committed');
  });

  it('checks labeled links on every kind, a paper included', async () => {
    const { actor } = await person();
    const paperId = await savePaper({
      title: 'Linear attention',
      authors: [],
      abstract: null,
      year: 2020,
      venue: null,
      source: 'arxiv',
      metadataLicense: 'CC0-1.0',
      abstractLicense: null,
      identifiers: [{ scheme: 'arxiv', value: '2006.16236' }],
    });
    const write = (content: string) =>
      commitPage(paperId, null, actor, [{ path: 'community/links.jsonl', content }], 'Links');
    await expect(write('{"id":"a","to":"topic:linear-attention","label":"in-topic"}\n')).resolves.toMatchObject({
      status: 'committed',
    });
    await expect(write('{"id":"a","to":"arxiv:1706.03762","label":"in-topic"}\n')).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('goes to topic pages'),
    });
    await expect(write('{"id":"a","to":"arxiv:1706.03762","label":"contradicts"}\n')).rejects.toMatchObject({
      message: expect.stringContaining('needs a note'),
    });
    await expect(write('{"id":"a","to":"nowhere:x","label":"related"}\n')).rejects.toMatchObject({
      message: expect.stringContaining('not an identifier'),
    });
    await expect(
      write('{"id":"a","to":"venue:iclr","label":"related"}\n{"id":"a","to":"org:eth","label":"related"}\n'),
    ).rejects.toMatchObject({ message: expect.stringContaining('used twice') });
    // The authors' links are the authors'.
    await expect(
      commitPage(paperId, null, actor, [{ path: 'owners/links.jsonl', content: '' }], 'x'),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// ------------------------------------------------------------------------------------- clone and push

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' };

function gitAsync(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'credential.helper=', ...args],
      { cwd, timeout: 60_000, env: { ...process.env, ...QUIET_ENV } },
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.replace(/[ \t]+$/gm, '') }),
    );
  });
}

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const request = new Request(new URL(req.url!, base), {
      method: req.method,
      headers,
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await (req.method === 'POST' ? gitRoute.POST(request) : gitRoute.GET(request));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

describe('clone and push', () => {
  it('clones a venue page at /git/venue/<key>.git and pushes to it under its rules', async () => {
    const venue = await createPage('venue', 'iclr/2027');
    const { account } = await person();
    const { token } = await mintToken({ account, name: 'git', scopes: ['push'] });
    const actor = { kind: 'account', accountId: account.id, isAdmin: false } as const;
    const address = { kind: 'venue', key: 'iclr/2027' } as const;
    expect(pageClonePath(address)).toBe('/git/venue/iclr/2027.git');

    const dir = mkdtempSync(join(tmpdir(), 'kinds-'));
    dirs.push(dir);
    const clone = join(dir, 'page');
    expect(await gitAsync(['clone', '-q', `${base}${pageClonePath(address)}`, clone], dir)).toMatchObject({ ok: true });
    expect(readFileSync(join(clone, '.potentialpaper/metadata.json'), 'utf8')).toContain('"kind": "venue"');
    git(
      ['remote', 'set-url', '--push', 'origin', `${base.replace('//', `//anyone:${token}@`)}${pageClonePath(address)}`],
      clone,
    );
    const { name, email } = await gitIdentity(venue.id, actor);
    git(['config', 'user.name', name], clone);
    git(['config', 'user.email', email], clone);
    git(['config', 'commit.gpgsign', 'false'], clone);

    execFileSync('mkdir', ['-p', join(clone, 'community')]);
    writeFileSync(join(clone, 'community/10-about.md'), '# About\n\nThe conference.\n');
    git(['add', '-A'], clone);
    git(['commit', '-q', '-m', 'About the venue'], clone);
    const pushed = await gitAsync(['push', '--progress', 'origin', 'HEAD:main'], clone);
    expect(pushed.ok, pushed.output).toBe(true);
    expect(pushed.output).toContain('remote: 1 commit added: http://test.local/v/iclr/2027');
    expect(await readHead(getDb(), venue.id)).toBe(git(['rev-parse', 'HEAD'], clone));

    // The organisers' part isn't theirs: refused as a web edit would be.
    execFileSync('mkdir', ['-p', join(clone, 'owners')]);
    writeFileSync(join(clone, 'owners/10-welcome.md'), 'Welcome\n');
    git(['add', '-A'], clone);
    git(['commit', '-q', '-m', 'Welcome'], clone);
    const refused = await gitAsync(['push', 'origin', 'HEAD:main'], clone);
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain('organisers');

    // Another spelling of a missing page, and a page with no such key, are not found.
    expect((await fetch(`${base}/git/venue/nope.git/info/refs`)).status).toBe(404);
    expect((await fetch(`${base}/git/venue/Not%20A%20Slug.git/info/refs`)).status).toBe(404);
  });
});
