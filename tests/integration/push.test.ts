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
import { accounts, authorClaims, pageCurrent, pageRevisions, type TokenScope } from '@/db/schema';
import { clonePath } from '@/server/pages/clone';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { gitIdentity } from '@/server/pages/receive';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { mintToken } from '@/server/tokens';
import { closePool, resetDatabase } from './helpers';

/**
 * `git push` over HTTP, with stock git against the route in this process: token auth, the pack (thin, with
 * deltas), `receiveCommits`' refusals as git prints them, and the page as the site shows it afterwards.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

/** Never prompts, and no helper on this machine answers for it. */
const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' };

/** A git command talking to the server in this process, so not blocking it. Resolves with all it printed. */
function gitAsync(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'credential.helper=', ...args],
      { cwd, timeout: 60_000, env: { ...process.env, ...QUIET_ENV } },
      // Git pads each `remote:` line with spaces, to clear what a terminal had there.
      (err, stdout, stderr) => resolve({ ok: !err, output: `${stdout}${stderr}`.replace(/[ \t]+$/gm, '') }),
    );
  });
}

let server: Server;
let base: string;
const requests: string[] = [];
/** The size of each request body, by path. */
const bodies: { path: string; bytes: number }[] = [];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization ? 'auth' : 'anonymous'}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push({ path: req.url!, bytes: Buffer.concat(chunks).length });
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

let count = 0;

async function newPaper() {
  count += 1;
  const id = { scheme: 'arxiv', value: `2201.${String(count).padStart(5, '0')}` } as const;
  const paperId = await savePaper({
    title: `Paper ${count}`,
    authors: ['Ada Lovelace', 'Emmy Noether'],
    abstract: 'An abstract.',
    year: 2022,
    venue: null,
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [id],
  });
  await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start the page');
  return { paperId, id };
}

async function newPusher(fields: Partial<typeof accounts.$inferInsert> = {}, scopes: TokenScope[] = ['push']) {
  count += 1;
  const [account] = await getDb()
    .insert(accounts)
    .values({ handle: `pusher-${count}`, verifiedAt: new Date(), ...fields })
    .returning();
  const { token } = await mintToken({ account, name: 'git', scopes });
  return { actor: { kind: 'account', accountId: account.id, isAdmin: false } as const, token, handle: account.handle };
}

/** A clone of the page, its `origin` carrying the token as git's password, its identity set to `name`. */
async function cloneAs(id: { scheme: 'arxiv'; value: string }, token: string | null, name?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'push-'));
  dirs.push(dir);
  const clone = join(dir, 'page');
  const cloned = await gitAsync(['clone', '-q', `${base}${clonePath(id)}`, clone], dir);
  expect(cloned).toMatchObject({ ok: true });
  if (token)
    git(
      ['remote', 'set-url', '--push', 'origin', `${base.replace('//', `//anyone:${token}@`)}${clonePath(id)}`],
      clone,
    );
  if (name) {
    git(['config', 'user.name', name], clone);
    git(['config', 'user.email', `${name}@users.invalid`], clone);
  }
  git(['config', 'commit.gpgsign', 'false'], clone);
  return clone;
}

function commit(clone: string, files: Record<string, string>, message = 'Edit by hand'): string {
  for (const [path, content] of Object.entries(files)) {
    execFileSync('mkdir', ['-p', join(clone, path, '..')]);
    writeFileSync(join(clone, path), content);
  }
  git(['add', '-A'], clone);
  git(['commit', '-q', '-m', message], clone);
  return git(['rev-parse', 'HEAD'], clone);
}

const push = (clone: string, ...args: string[]) => gitAsync(['push', ...args, 'origin', 'main'], clone);

describe('git push over HTTPS', () => {
  it('stores the commits as they are, and the page shows them', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    const { name } = await gitIdentity(paperId, actor);
    const clone = await cloneAs(id, token, name);
    // A big file first, then a one-line change, which git sends as a delta against the server's copy.
    const lines = Array.from({ length: 1500 }, (_, i) => `Line ${i} of a summary long enough to be sent as a delta.`);
    const first = commit(clone, { 'community/10-summary.md': `# Summary\n\n${lines.join('\n')}\n` });
    requests.length = 0;
    // `--progress`, or git asks the server to be quiet when no terminal is watching.
    const pushed = await push(clone, '--progress');
    expect(pushed).toMatchObject({ ok: true });
    expect(pushed.output).toContain(`remote: 1 commit added: http://test.local/abs/${id.value}`);
    // Asked without credentials first, then with them, as git does when the server says 401.
    expect(requests).toContain(`GET ${clonePath(id)}/info/refs?service=git-receive-pack anonymous`);
    expect(requests.at(-1)).toBe(`POST ${clonePath(id)}/git-receive-pack auth`);
    expect(await readHead(getDb(), paperId)).toBe(first);

    lines[700] = 'A line changed on its own.';
    const second = commit(clone, { 'community/10-summary.md': `# Summary\n\n${lines.join('\n')}\n` }, 'Fix line 700');
    expect(await push(clone)).toMatchObject({ ok: true });
    expect(await readHead(getDb(), paperId)).toBe(second);
    // A thin pack: the changed file went as a delta against the copy only the server had in this push.
    const sent = bodies.filter((b) => b.path.endsWith('/git-receive-pack')).map((b) => b.bytes);
    expect(sent.at(-1)).toBeLessThan(sent.at(-2)! / 4);
    const third = commit(clone, { 'community/20-more.md': '# More\n\nAnd *more*.\n' }, 'Add a section');
    expect(await push(clone)).toMatchObject({ ok: true });
    expect(await readHead(getDb(), paperId)).toBe(third);
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(current.communityHtml).toContain('A line changed on its own.');
    expect(current.communityHtml).toContain('<em>more</em>');
    const revisions = await getDb().select().from(pageRevisions).where(eq(pageRevisions.paperId, paperId));
    expect(revisions.map((r) => r.oid.toString('hex'))).toEqual(expect.arrayContaining([first, second, third]));
    // A fresh clone has exactly the pushed commits.
    const again = await cloneAs(id, null);
    expect(git(['rev-parse', 'HEAD'], again)).toBe(third);
    git(['fsck', '--full', '--strict', '--no-dangling'], again);
  });

  it('refuses a wrong identity, saying what to set', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    const { name, email } = await gitIdentity(paperId, actor);
    const clone = await cloneAs(id, token);
    git(['config', 'user.name', 'Ada Lovelace'], clone);
    git(['config', 'user.email', 'ada@example.org'], clone);
    const head = await readHead(getDb(), paperId);
    commit(clone, { 'community/10-summary.md': '# Hi\n' });
    const pushed = await push(clone);
    expect(pushed.ok).toBe(false);
    expect(pushed.output).toContain('its author is “Ada Lovelace <ada@example.org>”');
    expect(pushed.output).toContain(`remote:     git config user.name ${name}\n`);
    expect(pushed.output).toContain(`remote:     git config user.email ${email}\n`);
    expect(pushed.output).toContain('[remote rejected] main -> main (wrong author identity)');
    expect(await readHead(getDb(), paperId)).toBe(head);

    // Doing what it says works.
    git(['config', 'user.name', name], clone);
    git(['config', 'user.email', email], clone);
    git(['commit', '-q', '--amend', '--reset-author', '--no-edit'], clone);
    expect(await push(clone)).toMatchObject({ ok: true });
  });

  it('refuses what is not a fast-forward of the page, and merge commits', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    const { name } = await gitIdentity(paperId, actor);
    const clone = await cloneAs(id, token, name);
    const start = await readHead(getDb(), paperId);
    // Someone edits on the site meanwhile.
    const web = await commitPage(paperId, start, actor, [{ path: 'community/10-web.md', content: '# Web\n' }], 'Web');
    commit(clone, { 'community/20-mine.md': '# Mine\n' });
    const behind = await push(clone);
    expect(behind.ok).toBe(false);
    expect(behind.output).toMatch(/\[rejected\]\s+main -> main \(fetch first\)/);
    const forced = await push(clone, '--force');
    expect(forced.ok).toBe(false);
    expect(forced.output).toContain('remote: the page has commits after');
    expect(forced.output).toContain('[remote rejected] main -> main (non-fast-forward)');
    expect(await readHead(getDb(), paperId)).toBe(web.oid);

    // A merge of the two is refused, and a rebase goes through.
    expect((await gitAsync(['fetch', '-q', 'origin'], clone)).ok).toBe(true);
    git(['merge', '-q', '--no-edit', 'origin/main'], clone);
    const merged = await push(clone);
    expect(merged.output).toContain('is a merge; a page');
    expect(merged.output).toContain('[remote rejected] main -> main (refused)');
    git(['reset', '-q', '--hard', 'HEAD^'], clone);
    git(['rebase', '-q', 'origin/main'], clone);
    expect(await push(clone)).toMatchObject({ ok: true });
    expect(await readHead(getDb(), paperId)).toBe(git(['rev-parse', 'HEAD'], clone));
  });

  it('refuses a path the account may not write, other branches, tags and deletes', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    const { name } = await gitIdentity(paperId, actor);
    const clone = await cloneAs(id, token, name);
    const head = await readHead(getDb(), paperId);
    commit(clone, { 'author/10-tl-dr.md': '# TL;DR\n' });
    const author = await push(clone);
    expect(author.ok).toBe(false);
    expect(author.output).toMatch(/remote: commit [0-9a-f]{7}: .*author/);
    expect(author.output).toContain('[remote rejected] main -> main (not allowed)');
    git(['reset', '-q', '--hard', 'origin/main'], clone);

    commit(clone, { 'community/10-ok.md': '# OK\n' });
    git(['tag', 'v1'], clone);
    const other = await gitAsync(['push', 'origin', 'HEAD:refs/heads/draft', 'v1'], clone);
    expect(other.output).toContain('[remote rejected] HEAD -> draft (only main)');
    expect(other.output).toContain('[remote rejected] v1 -> v1 (pages have no tags)');
    expect(other.output).toContain('remote: refs/heads/draft: a page has one branch, main');
    const atomic = await gitAsync(['push', '--atomic', 'origin', 'main', 'HEAD:refs/heads/draft'], clone);
    expect(atomic.ok).toBe(false);
    expect(await readHead(getDb(), paperId)).toBe(head);
    const deleted = await gitAsync(['push', 'origin', ':main'], clone);
    expect(deleted.ok).toBe(false);
    expect(await readHead(getDb(), paperId)).toBe(head);
    // The page itself goes through.
    expect(await push(clone)).toMatchObject({ ok: true });
  });

  it('needs a valid key that may push, from a confirmed account', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    const { name } = await gitIdentity(paperId, actor);
    const head = await readHead(getDb(), paperId);
    const anonymous = await cloneAs(id, null, name);
    commit(anonymous, { 'community/10-x.md': '# X\n' });
    const none = await push(anonymous);
    expect(none.ok).toBe(false);
    expect(none.output).toMatch(/could not read Username|Authentication failed/);

    const wrong = await cloneAs(id, `pp_live_${'x'.repeat(43)}`, name);
    commit(wrong, { 'community/10-x.md': '# X\n' });
    expect((await push(wrong)).output).toContain('Authentication failed');

    const reader = await newPusher({}, ['read']);
    const readOnly = await cloneAs(id, reader.token, name);
    commit(readOnly, { 'community/10-x.md': '# X\n' });
    expect((await push(readOnly)).output).toContain('This API key may not push');

    const unverified = await newPusher({ verifiedAt: null });
    const fresh = await cloneAs(id, unverified.token, name);
    commit(fresh, { 'community/10-x.md': '# X\n' });
    expect((await push(fresh)).output).toContain('Confirm an institutional email address');
    expect(await readHead(getDb(), paperId)).toBe(head);

    // A key with `write` (an agent's) may push too.
    const agent = await newPusher({}, ['read', 'write']);
    const agentName = (await gitIdentity(paperId, agent.actor)).name;
    const ok = await cloneAs(id, agent.token, agentName);
    const tip = commit(ok, { 'community/10-x.md': '# X\n' });
    expect(await push(ok)).toMatchObject({ ok: true });
    expect(await readHead(getDb(), paperId)).toBe(tip);
    expect(token).toMatch(/^pp_live_/);
  });

  it('takes the author section from a confirmed author, as the per-claim identity', async () => {
    const { paperId, id } = await newPaper();
    const { actor, token } = await newPusher();
    await getDb().insert(authorClaims).values({
      paperId,
      accountId: actor.accountId,
      authorIndex: 1,
      authorName: 'Emmy Noether',
      identityId: 'a_noether1',
      status: 'confirmed',
    });
    const identity = await gitIdentity(paperId, actor);
    expect(identity.name).toBe('a_noether1');
    const clone = await cloneAs(id, token, identity.name);
    const tip = commit(clone, { 'author/10-tl-dr.md': '# TL;DR\n\nRings, *abstractly*.\n' }, 'Write the TL;DR');
    expect(await push(clone)).toMatchObject({ ok: true });
    expect(await readHead(getDb(), paperId)).toBe(tip);
    expect(git(['log', '-1', '--format=%an <%ae> %cn', tip], clone)).toBe(
      'a_noether1 <a_noether1@users.invalid> a_noether1',
    );
    const [current] = await getDb().select().from(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    expect(current.authorHtml).toContain('<em>abstractly</em>');
    expect(readFileSync(join(clone, 'author/10-tl-dr.md'), 'utf8')).toContain('Rings');

    // Their handle's identity is refused on this paper.
    const handleId = (await gitIdentity((await newPaper()).paperId, actor)).name;
    git(['config', 'user.name', handleId], clone);
    git(['config', 'user.email', `${handleId}@users.invalid`], clone);
    commit(clone, { 'author/10-tl-dr.md': '# TL;DR\n\nAgain.\n' });
    const refused = await push(clone);
    expect(refused.output).toContain('git config user.name a_noether1');
    expect(await readHead(getDb(), paperId)).toBe(tip);
  });
});
