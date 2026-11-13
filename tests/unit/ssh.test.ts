import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseSshCommand, parseSshPath, sqDequote } from '@/server/git/ssh-command';
import { fingerprintOf, KeyError, parsePublicKey } from '@/server/ssh-keys';

const dir = mkdtempSync(join(tmpdir(), 'ssh-keys-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A fresh key pair from `ssh-keygen`, and what it says the fingerprint is. */
function keygen(...args: string[]): { pub: string; fingerprint: string } {
  const file = join(dir, `k${n++}`);
  execFileSync('ssh-keygen', ['-q', '-N', '', '-C', 'me@laptop', '-f', file, ...args]);
  const pub = readFileSync(`${file}.pub`, 'utf8');
  const fingerprint = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', `${file}.pub`])
    .toString()
    .split(' ')[1];
  return { pub, fingerprint };
}

/** A key blob in SSH's wire format, from its strings. */
function blob(...parts: (string | Buffer)[]): string {
  return Buffer.concat(
    parts.map((p) => {
      const b = typeof p === 'string' ? Buffer.from(p) : p;
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length);
      return Buffer.concat([len, b]);
    }),
  ).toString('base64');
}

describe('parsePublicKey', () => {
  it.each([
    ['ssh-ed25519', ['-t', 'ed25519']],
    ['ecdsa-sha2-nistp256', ['-t', 'ecdsa', '-b', '256']],
    ['ecdsa-sha2-nistp384', ['-t', 'ecdsa', '-b', '384']],
    ['ecdsa-sha2-nistp521', ['-t', 'ecdsa', '-b', '521']],
    ['ssh-rsa', ['-t', 'rsa', '-b', '3072']],
  ])('takes %s keys, with the fingerprint ssh-keygen prints', (type, args) => {
    const { pub, fingerprint } = keygen(...args);
    const key = parsePublicKey(pub);
    expect(key.type).toBe(type);
    expect(key.fingerprint).toBe(fingerprint);
    expect(key.comment).toBe('me@laptop');
    expect(key.publicKey).toBe(pub.trim().split(' ').slice(0, 2).join(' '));
    expect(fingerprintOf(key.blob)).toBe(fingerprint);
    if (type === 'ssh-rsa') expect(key.bits).toBe(3072);
  });

  it('takes a key with no comment and extra spaces', () => {
    const { pub } = keygen('-t', 'ed25519');
    const bare = pub.trim().split(' ').slice(0, 2).join('   ');
    expect(parsePublicKey(`  ${bare}\n`).comment).toBe('');
  });

  it('refuses RSA keys under 3072 bits', () => {
    const { pub } = keygen('-t', 'rsa', '-b', '2048');
    expect(() => parsePublicKey(pub)).toThrow(/2048 bits; it needs at least 3072/);
  });

  it('refuses DSA, security keys and unknown types', () => {
    const dsa = `ssh-dss ${blob('ssh-dss', Buffer.alloc(128, 1), Buffer.alloc(20, 1), Buffer.alloc(128, 1), Buffer.alloc(128, 1))}`;
    expect(() => parsePublicKey(dsa)).toThrow(/DSA keys are no longer safe/);
    const sk = `sk-ssh-ed25519@openssh.com ${blob('sk-ssh-ed25519@openssh.com', Buffer.alloc(32), 'ssh:')}`;
    expect(() => parsePublicKey(sk)).toThrow(/Security-key/);
    expect(() => parsePublicKey(`ssh-foo ${blob('ssh-foo')}`)).toThrow(/not supported/);
  });

  it('refuses private keys, junk and broken blobs', () => {
    expect(() => parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----')).toThrow(
      /private key/,
    );
    expect(() => parsePublicKey('')).toThrow(KeyError);
    expect(() => parsePublicKey('hello')).toThrow(KeyError);
    const { pub } = keygen('-t', 'ed25519');
    expect(() => parsePublicKey(`${pub.trim()}\n${pub.trim()}`)).toThrow(/one key/);
    // The type outside and inside disagree.
    expect(() => parsePublicKey(`ssh-rsa ${pub.split(' ')[1]}`)).toThrow(/not an ssh-rsa key/);
    // Short Ed25519 key, bytes after the end, a wrong curve, a cut-off string.
    expect(() => parsePublicKey(`ssh-ed25519 ${blob('ssh-ed25519', Buffer.alloc(31))}`)).toThrow(/wrong length/);
    expect(() => parsePublicKey(`ssh-ed25519 ${blob('ssh-ed25519', Buffer.alloc(32), 'x')}`)).toThrow(/after its end/);
    expect(() =>
      parsePublicKey(`ecdsa-sha2-nistp256 ${blob('ecdsa-sha2-nistp256', 'nistp384', Buffer.alloc(65, 4))}`),
    ).toThrow(/different curve/);
    const cut = Buffer.from(blob('ssh-ed25519', Buffer.alloc(32)), 'base64')
      .subarray(0, 30)
      .toString('base64');
    expect(() => parsePublicKey(`ssh-ed25519 ${cut}`)).toThrow(/cut short/);
    expect(() => parsePublicKey('ssh-ed25519 AAAA$$$')).toThrow(KeyError);
  });
});

describe('the exec command', () => {
  it('dequotes as git quotes', () => {
    expect(sqDequote("'abs/1706.03762.git'")).toBe('abs/1706.03762.git');
    expect(sqDequote("'it'\\''s'")).toBe("it's");
    expect(sqDequote("'wow'\\!'x'")).toBe('wow!x');
    expect(sqDequote("''")).toBe('');
    for (const bad of ['abs/1', "'abs", "'a' 'b'", "'a'b", "'a'\\x'", "'a'\\'", "'a';rm -rf /"]) {
      expect(sqDequote(bad)).toBeNull();
    }
  });

  it('runs only the two git services, with one quoted path', () => {
    expect(parseSshCommand("git-upload-pack '/abs/1706.03762.git'")).toEqual({
      service: 'git-upload-pack',
      path: '/abs/1706.03762.git',
    });
    expect(parseSshCommand("git-receive-pack 'abs/1706.03762'")).toEqual({
      service: 'git-receive-pack',
      path: 'abs/1706.03762',
    });
    for (const bad of [
      'ls',
      '',
      "git-upload-archive 'abs/1706.03762.git'",
      "git upload-pack 'abs/1706.03762.git'",
      'git-upload-pack abs/1706.03762.git',
      "git-upload-pack  'abs/1706.03762.git'",
      "git-upload-pack 'abs/1706.03762.git'; ls",
      "git-upload-pack 'a' 'b'",
      `git-upload-pack '${'a'.repeat(2000)}'`,
    ]) {
      expect(parseSshCommand(bad), bad).toBeNull();
    }
  });

  it('takes the page addresses the HTTP route takes', () => {
    const want = {
      id: { scheme: 'arxiv', value: '1706.03762' },
      scheme: 'arxiv',
      raw: '1706.03762',
      file: 'git-upload-pack',
    };
    for (const path of [
      '/abs/1706.03762.git',
      'abs/1706.03762.git',
      'abs/1706.03762',
      '/arxiv/1706.03762.git',
      '/git/arxiv/1706.03762.git',
      'git/abs/1706.03762',
    ]) {
      expect(parseSshPath(path, 'git-upload-pack'), path).toEqual(want);
    }
    // Another spelling of the same paper: `findRepo` then sends to the canonical address.
    expect(parseSshPath('abs/1706.03762v2.git', 'git-receive-pack')).toMatchObject({
      id: { scheme: 'arxiv', value: '1706.03762' },
      raw: '1706.03762v2',
      file: 'git-receive-pack',
    });
    expect(parseSshPath('/doi/10.1000/xyz123.git', 'git-upload-pack')).toMatchObject({
      id: { scheme: 'doi', value: '10.1000/xyz123' },
    });
    expect(parseSshPath('openreview/dskf2Ppd9o', 'git-upload-pack')).toMatchObject({
      id: { scheme: 'openreview', value: 'dskf2Ppd9o' },
    });
    for (const bad of [
      '',
      'abs',
      'abs/',
      '/etc/passwd',
      'abs/1706.03762/',
      'abs//1706.03762',
      'abs/not-an-id',
      'abs/1706.03762\n.git',
      'pdf/1706.03762',
      '~/abs/1706.03762.git',
      '../abs/1706.03762.git',
    ]) {
      expect(parseSshPath(bad, 'git-upload-pack'), bad).toBeNull();
    }
  });
});
