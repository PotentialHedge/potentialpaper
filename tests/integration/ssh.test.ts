import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { utils } from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, sshKeys } from '@/db/schema';
import { createSshServer } from '@/server/git/ssh';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { gitIdentity } from '@/server/pages/receive';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { addSshKey } from '@/server/ssh-keys';
import { api, closePool, resetDatabase, signUp } from './helpers';

/**
 * Git over SSH with stock `git` and `ssh` against the server in this process, on a random port: clone and push
 * as a key's account, the refusals as git prints them, a bare `ssh` session's greeting, and the keys API.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const work = mkdtempSync(join(tmpdir(), 'ssh-it-'));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

let server: Server;
let port: number;
const logged: unknown[][] = [];
const hostKey = utils.generateKeyPairSync('ed25519');
const knownHosts = join(work, 'known_hosts');

beforeAll(async () => {
  server = createSshServer({
    hostKeys: [hostKey.private],
    database: getDb(),
    log: (...args) => logged.push(args),
    limits: { maxConnectionsPerIp: 50, connectionBurstPerIp: 500 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  // The client checks the server's key against this, as it would against a fingerprint someone published.
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey.public}\n`);
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

let count = 0;

/** A key pair made by `ssh-keygen`, as a person would have one. */
function keygen(type = 'ed25519'): { file: string; pub: string } {
  count += 1;
  const file = join(work, `id_${count}`);
  execFileSync('ssh-keygen', ['-q', '-N', '', '-t', type, '-C', `key ${count}`, '-f', file]);
  chmodSync(file, 0o600);
  return { file, pub: readFileSync(`${file}.pub`, 'utf8') };
}

/** `ssh` that uses only this key, trusts only this server's host key, and never asks anything. */
function sshArgs(keyFile: string): string[] {
  return [
    '-F',
    '/dev/null',
    '-i',
    keyFile,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'IdentityAgent=none',
    '-o',
    'BatchMode=yes',
    '-o',
    `UserKnownHostsFile=${knownHosts}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'LogLevel=ERROR',
  ];
}

const QUIET_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_CONFIG_NOSYSTEM: '1' };

function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  return new Promise<{ ok: boolean; code: number; output: string }>((resolve) => {
    execFile(
      command,
      args,
      { cwd: options.cwd ?? work, timeout: 60_000, env: { ...process.env, ...QUIET_ENV, ...options.env } },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
          output: `${stdout}${stderr}`.replace(/[ \t]+$/gm, ''),
        }),
    );
  });
}

/** git with `GIT_SSH_COMMAND` set to this key. */
function gitWith(keyFile: string, args: string[], cwd = work) {
  return run('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    env: { GIT_SSH_COMMAND: ['ssh', ...sshArgs(keyFile)].join(' ') },
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();
}

async function newPaper({ start = true } = {}) {
  count += 1;
  const id = { scheme: 'arxiv', value: `2202.${String(count).padStart(5, '0')}` } as const;
  const paperId = await savePaper({
    title: `Paper ${count}`,
    authors: ['Ada Lovelace'],
    abstract: 'An abstract.',
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [id],
  });
  if (start) await commitPage(paperId, null, SYSTEM_ACTOR, [], 'Start the page');
  return { paperId, id };
}

/** An account with a key on it. */
async function newPusher(fields: Partial<typeof accounts.$inferInsert> = {}) {
  count += 1;
  const [account] = await getDb()
    .insert(accounts)
    .values({ handle: `ssh-user-${count}`, verifiedAt: new Date(), ...fields })
    .returning();
  const key = keygen();
  await addSshKey(account, { key: key.pub });
  return { account, key: key.file, actor: { kind: 'account', accountId: account.id, isAdmin: false } as const };
}

const sshUrl = (path: string) => `ssh://git@127.0.0.1:${port}/${path}`;

async function cloneAs(keyFile: string, url: string, name?: string) {
  const dir = mkdtempSync(join(work, 'clone-'));
  dirs.push(dir);
  const clone = join(dir, 'page');
  const cloned = await gitWith(keyFile, ['clone', '-q', url, clone], dir);
  expect(cloned.output).toBe('');
  expect(cloned.ok).toBe(true);
  if (name) {
    git(['config', 'user.name', name], clone);
    git(['config', 'user.email', `${name}@users.invalid`], clone);
  }
  git(['config', 'commit.gpgsign', 'false'], clone);
  return clone;
}

function commit(clone: string, files: Record<string, string>, message = 'Edit over SSH'): string {
  for (const [path, content] of Object.entries(files)) {
    execFileSync('mkdir', ['-p', join(clone, path, '..')]);
    writeFileSync(join(clone, path), content);
  }
  git(['add', '-A'], clone);
  git(['commit', '-q', '-m', message], clone);
  return git(['rev-parse', 'HEAD'], clone);
}

describe('git over SSH', () => {
  it('clones and pushes as the key’s account, at the page’s own address', async () => {
    const { paperId, id } = await newPaper();
    const { key, actor } = await newPusher();
    const { name } = await gitIdentity(paperId, actor);
    const clone = await cloneAs(key, sshUrl(`abs/${id.value}.git`), name);
    expect(git(['rev-parse', 'HEAD'], clone)).toBe(await readHead(getDb(), paperId));

    const tip = commit(clone, { 'community/10-summary.md': '# Summary\n\nPushed over SSH.\n' });
    const pushed = await gitWith(key, ['push', '--progress', 'origin', 'main'], clone);
    expect(pushed.output).toContain('remote: 1 commit added: http://test.local/s/');
    expect(pushed.ok).toBe(true);
    expect(await readHead(getDb(), paperId)).toBe(tip);

    // The other spellings of the address, and protocol v0, reach the same repo.
    for (const [url, version] of [
      [sshUrl(`arxiv/${id.value}`), '2'],
      [sshUrl(`git/arxiv/${id.value}.git`), '0'],
      [`git@127.0.0.1:abs/${id.value}.git`, '2'],
      [sshUrl(`abs/${id.value}v1.git`), '2'],
    ]) {
      const dir = mkdtempSync(join(work, 'again-'));
      dirs.push(dir);
      const again = await run('git', ['-c', `protocol.version=${version}`, 'clone', '-q', url, 'page'], {
        cwd: dir,
        env: { GIT_SSH_COMMAND: ['ssh', ...sshArgs(key), '-p', String(port)].join(' ') },
      });
      expect(again, url).toMatchObject({ ok: true, output: '' });
      expect(git(['rev-parse', 'HEAD'], join(dir, 'page'))).toBe(tip);
      git(['fsck', '--full', '--strict', '--no-dangling'], join(dir, 'page'));
    }

    // A second push: only the new objects go.
    const second = commit(clone, { 'community/20-more.md': '# More\n' }, 'Add a section');
    expect(await gitWith(key, ['push', '-q', 'origin', 'main'], clone)).toMatchObject({ ok: true });
    expect(await readHead(getDb(), paperId)).toBe(second);
    const [row] = await getDb().select().from(sshKeys);
    expect(row.lastUsedAt).not.toBeNull();

    // Git asks for protocol v2 through `GIT_PROTOCOL` (SendEnv), and gets it.
    const traced = await run('git', ['ls-remote', sshUrl(`abs/${id.value}`)], {
      env: { GIT_SSH_COMMAND: ['ssh', ...sshArgs(key)].join(' '), GIT_TRACE_PACKET: '1' },
    });
    expect(traced.output).toMatch(/ls-remote< version 2/);
    expect(traced.output).toContain(`${second}\tHEAD`);
    expect(logged).toEqual([]);
  });

  it('shows a refused push’s reasons as remote: lines', async () => {
    const { paperId, id } = await newPaper();
    const { key, actor } = await newPusher();
    const { name, email } = await gitIdentity(paperId, actor);
    const clone = await cloneAs(key, sshUrl(`abs/${id.value}.git`), name);
    const head = await readHead(getDb(), paperId);

    commit(clone, { 'owners/10-tl-dr.md': '# TL;DR\n' });
    const author = await gitWith(key, ['push', 'origin', 'main'], clone);
    expect(author.ok).toBe(false);
    expect(author.output).toMatch(/remote: commit [0-9a-f]{7}: .*author/);
    expect(author.output).toContain('[remote rejected] main -> main (not allowed)');

    git(['reset', '-q', '--hard', 'origin/main'], clone);
    git(['config', 'user.name', 'Ada Lovelace'], clone);
    git(['config', 'user.email', 'ada@example.org'], clone);
    commit(clone, { 'community/10-summary.md': '# Hi\n' });
    const wrong = await gitWith(key, ['push', 'origin', 'main'], clone);
    expect(wrong.output).toContain(`remote:     git config user.name ${name}\n`);
    expect(wrong.output).toContain(`remote:     git config user.email ${email}\n`);
    expect(wrong.output).toContain('[remote rejected] main -> main (wrong author identity)');
    expect(await readHead(getDb(), paperId)).toBe(head);
  });

  it('lets an unconfirmed account clone but not push', async () => {
    const { paperId, id } = await newPaper();
    const { key, actor } = await newPusher({ verifiedAt: null });
    const { name } = await gitIdentity(paperId, actor);
    const clone = await cloneAs(key, sshUrl(`abs/${id.value}.git`), name);
    commit(clone, { 'community/10-summary.md': '# Hi\n' });
    const pushed = await gitWith(key, ['push', 'origin', 'main'], clone);
    expect(pushed.ok).toBe(false);
    expect(pushed.output).toContain('ERROR: Confirm an institutional email address before you push.');
  });

  it('refuses a key it doesn’t know, and other users', async () => {
    const { id } = await newPaper();
    const stranger = keygen();
    const refused = await gitWith(stranger.file, ['clone', '-q', sshUrl(`abs/${id.value}.git`), 'x']);
    expect(refused.ok).toBe(false);
    expect(refused.output).toContain('Permission denied (publickey)');

    const { key } = await newPusher();
    const root = await run('ssh', [...sshArgs(key), '-p', String(port), '-T', 'root@127.0.0.1']);
    expect(root.output).toContain('Permission denied (publickey)');
  });

  it('greets a bare ssh session and runs nothing else', async () => {
    const { key, account } = await newPusher();
    const bare = await run('ssh', [...sshArgs(key), '-p', String(port), '-T', 'git@127.0.0.1']);
    expect(bare.code).toBe(1);
    expect(bare.output).toBe(
      `Hi ${account.handle}! You've authenticated, but potentialpaper does not provide shell access.\n`,
    );
    const asked = await run('ssh', [...sshArgs(key), '-p', String(port), 'git@127.0.0.1', 'ls -la']);
    expect(asked.code).toBe(128);
    expect(asked.output).toContain('ERROR: Invalid command: "ls -la"');
    const forward = await run('ssh', [
      ...sshArgs(key),
      '-p',
      String(port),
      '-N',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      '0:127.0.0.1:22',
      'git@127.0.0.1',
    ]);
    expect(forward.ok).toBe(false);
    const sftp = await run('ssh', [...sshArgs(key), '-p', String(port), '-s', 'git@127.0.0.1', 'sftp']);
    expect(sftp.ok).toBe(false);
  });

  it('starts the repo of a paper nobody has edited when it is cloned', async () => {
    const { paperId, id } = await newPaper({ start: false });
    const { key } = await newPusher();
    const clone = await cloneAs(key, sshUrl(`abs/${id.value}.git`));
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toMatch(/^# This is a paper's page/);
    expect(git(['rev-parse', 'HEAD'], clone)).toBe(await readHead(getDb(), paperId));
  });

  it('says so for an address with no page', async () => {
    const { key } = await newPusher();
    const missing = await gitWith(key, ['clone', '-q', sshUrl('abs/2299.99999.git'), 'x']);
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain('ERROR: No page at arxiv/2299.99999.');
    const junk = await gitWith(key, ['clone', '-q', sshUrl('etc/passwd'), 'y']);
    expect(junk.output).toContain("ERROR: '/etc/passwd' is not a page's address.");
  });
});

describe('SSH limits', () => {
  it('drops connections past an address’s bucket, and ones that never sign in', async () => {
    const limited = createSshServer({
      hostKeys: [hostKey.private],
      database: getDb(),
      limits: { connectionBurstPerIp: 1, connectionsPerSecondPerIp: 0.001, authTimeoutMs: 500 },
    });
    await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
    const limitedPort = (limited.address() as AddressInfo).port;
    try {
      const { key } = await newPusher();
      // The first connection is let in, then sits without signing in until it is closed.
      const idle = connect(limitedPort, '127.0.0.1');
      const closed = new Promise((resolve) => idle.once('close', resolve));
      idle.on('error', () => {});
      // Read what comes (the server's version line), so the end of the stream is seen.
      idle.resume();
      const started = Date.now();
      await closed;
      expect(Date.now() - started).toBeLessThan(5000);
      const second = await run('ssh', [...sshArgs(key), '-p', String(limitedPort), '-T', 'git@127.0.0.1']);
      expect(second.ok).toBe(false);
      expect(second.output).not.toContain('Hi ');
    } finally {
      await new Promise((resolve) => limited.close(resolve));
    }
  });
});

describe('SSH keys on the profile', () => {
  it('adds, lists and removes keys; a key belongs to one account', async () => {
    const cookie = await signUp('ada@example.org');
    const { pub } = keygen();
    const added = await api('POST', '/me/ssh-keys', { cookie, body: { key: pub } });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ title: `key ${count}`, keyType: 'ssh-ed25519', lastUsedAt: null });
    expect(added.body.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

    const again = await api('POST', '/me/ssh-keys', { cookie, body: { key: pub, title: 'twice' } });
    expect(again).toMatchObject({ status: 409, body: { error: { code: 'ssh_key_taken' } } });
    const other = await signUp('emmy@example.org');
    expect((await api('POST', '/me/ssh-keys', { cookie: other, body: { key: pub } })).status).toBe(409);

    const rsa = keygen('rsa');
    const titled = await api('POST', '/me/ssh-keys', { cookie, body: { key: rsa.pub, title: ' Laptop ' } });
    expect(titled.body).toMatchObject({ title: 'Laptop', keyType: 'ssh-rsa' });
    const bad = await api('POST', '/me/ssh-keys', { cookie, body: { key: 'ssh-dss AAAA' } });
    expect(bad).toMatchObject({ status: 422, body: { error: { code: 'invalid_ssh_key' } } });

    const listed = await api('GET', '/me/ssh-keys', { cookie });
    expect(listed.body.keys.map((k: { title: string }) => k.title)).toEqual(['Laptop', `key ${count - 1}`]);
    expect((await api('GET', '/me/ssh-keys', { cookie: other })).body.keys).toEqual([]);

    // Only its own account removes a key.
    expect((await api('DELETE', `/me/ssh-keys/${added.body.id}`, { cookie: other })).status).toBe(404);
    expect((await api('DELETE', `/me/ssh-keys/${added.body.id}`, { cookie })).status).toBe(200);
    expect((await api('GET', '/me/ssh-keys', { cookie })).body.keys).toHaveLength(1);
    // A browser session only: no API key, no anonymous.
    expect((await api('GET', '/me/ssh-keys')).status).toBe(401);
  });

  it('deletes an account’s keys with it', async () => {
    const { account } = await newPusher();
    expect(await getDb().select().from(sshKeys)).toHaveLength(1);
    await getDb().delete(accounts).where(eq(accounts.id, account.id));
    expect(await getDb().select().from(sshKeys)).toHaveLength(0);
  });
});
