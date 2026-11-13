import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packBuffer } from '@/server/git/pack';
import { applyDelta, type BaseReader, PackError, readPack } from '@/server/git/pack-reader';
import { gitObject, type GitObjectType } from '@/server/pages/git-objects';

/** Packs made by `git pack-objects`, read back: whole objects, both kinds of delta, and thin packs. */

function git(args: string[], cwd: string, input?: string | Buffer): Buffer {
  return execFileSync('git', args, { cwd, input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repo whose one big file changes a line a commit, so `pack-objects` makes deltas of it. */
function repoWithHistory(commits: number): { dir: string; tips: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pack-reader-'));
  dirs.push(dir);
  git(['init', '-q', '--initial-branch=main'], dir);
  git(['config', 'user.name', 'u_test'], dir);
  git(['config', 'user.email', 'u_test@users.invalid'], dir);
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i} of a file long enough to be worth a delta`);
  const tips: string[] = [];
  for (let c = 0; c < commits; c += 1) {
    lines[(c * 37) % lines.length] = `changed in commit ${c}`;
    writeFileSync(join(dir, 'big.md'), `${lines.join('\n')}\n`);
    writeFileSync(join(dir, `small-${c}.md`), `# ${c}\n`);
    git(['add', '.'], dir);
    git(['commit', '-q', '-m', `Commit ${c}`], dir);
  }
  for (const line of git(['rev-list', '--reverse', 'main'], dir).toString().split('\n').filter(Boolean)) {
    tips.push(line);
  }
  return { dir, tips };
}

/** Objects by id, as git has them, read in one `cat-file --batch`; ids git doesn't have are left out. */
function catFile(dir: string, oids: readonly string[]): Map<string, { type: GitObjectType; body: Buffer }> {
  const out = new Map<string, { type: GitObjectType; body: Buffer }>();
  const bytes = git(['cat-file', '--batch'], dir, oids.map((oid) => `${oid}\n`).join(''));
  for (let at = 0; at < bytes.length;) {
    const end = bytes.indexOf(0x0a, at);
    const [oid, type, size] = bytes.toString('latin1', at, end).split(' ');
    at = end + 1;
    if (type === 'missing') continue;
    out.set(oid, { type: type as GitObjectType, body: Buffer.from(bytes.subarray(at, at + Number(size))) });
    at += Number(size) + 1;
  }
  return out;
}

/** Every object the revisions name. */
function objectsOf(dir: string, revs: string): Map<string, { type: string; body: Buffer }> {
  const oids = git(['rev-list', '--objects', '--stdin'], dir, revs)
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(0, 40));
  return catFile(dir, oids);
}

/** How many of a pack's entries are deltas, as `git verify-pack` sees it. */
function deltas(pack: Buffer): number {
  const dir = mkdtempSync(join(tmpdir(), 'pack-reader-'));
  dirs.push(dir);
  git(['init', '-q', '--bare'], dir);
  const file = join(dir, 'objects/pack/test.pack');
  writeFileSync(file, pack);
  git(['index-pack', file], dir);
  return git(['verify-pack', '-v', file.replace(/\.pack$/, '.idx')], dir)
    .toString()
    .split('\n')
    .filter((line) => /^[0-9a-f]{40} \S+ +\d+ \d+ \d+ \d+ [0-9a-f]{40}$/.test(line)).length;
}

function bases(dir: string): BaseReader {
  return async (oids) => catFile(dir, oids);
}

async function* chunked(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

function expectSame(
  read: Map<string, { type: string; body: Buffer }>,
  expected: Map<string, { type: string; body: Buffer }>,
) {
  expect([...read.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [oid, object] of expected) {
    expect(read.get(oid)!.type).toBe(object.type);
    expect(read.get(oid)!.body.equals(object.body)).toBe(true);
  }
}

describe('pack reader', () => {
  it('reads a pack with offset deltas, cut into chunks anywhere', async () => {
    const { dir, tips } = repoWithHistory(8);
    const pack = git(['pack-objects', '--stdout', '--revs', '--delta-base-offset', '-q'], dir, `${tips[7]}\n`);
    expect(deltas(pack)).toBeGreaterThan(3);
    const expected = objectsOf(dir, `${tips[7]}\n`);
    expectSame(await readPack(pack), expected);
    for (const size of [1, 7, 4096]) expectSame(await readPack(chunked(pack, size)), expected);
  });

  it('reads a pack with deltas by id', async () => {
    const { dir, tips } = repoWithHistory(6);
    const pack = git(['pack-objects', '--stdout', '--revs', '-q'], dir, `${tips[5]}\n`);
    expect(deltas(pack)).toBeGreaterThan(3);
    expectSame(await readPack(pack), objectsOf(dir, `${tips[5]}\n`));
  });

  it('reads a thin pack, its bases read from the server', async () => {
    const { dir, tips } = repoWithHistory(6);
    const revs = `${tips[5]}\n^${tips[2]}\n`;
    const pack = git(['pack-objects', '--stdout', '--revs', '--thin', '--delta-base-offset', '-q'], dir, revs);
    const expected = objectsOf(dir, revs);
    expectSame(await readPack(pack, { bases: bases(dir) }), expected);
    await expect(readPack(pack)).rejects.toThrow(/a delta against [0-9a-f]{40}, which is not here/);
    await expect(readPack(pack, { bases: async () => new Map() })).rejects.toThrow(PackError);
  });

  it('reads the packs git push sends, and an empty one', async () => {
    const { dir, tips } = repoWithHistory(3);
    const pack = git(
      ['pack-objects', '--all-progress-implied', '--revs', '--stdout', '--thin', '--delta-base-offset', '-q'],
      dir,
      `${tips[2]}\n^${tips[1]}\n`,
    );
    expectSame(await readPack(pack, { bases: bases(dir) }), objectsOf(dir, `${tips[2]}\n^${tips[1]}\n`));
    expect((await readPack(await packBuffer([]))).size).toBe(0);
  });

  it('reads no further than the trailer', async () => {
    const { dir, tips } = repoWithHistory(2);
    const pack = git(['pack-objects', '--stdout', '--revs', '-q'], dir, `${tips[1]}\n`);
    // A stream that never ends after the pack, as an SSH channel waiting for the answer.
    async function* open(): AsyncGenerator<Uint8Array> {
      yield* chunked(pack, 100);
      await new Promise(() => {});
    }
    expect((await readPack(open())).size).toBe(objectsOf(dir, `${tips[1]}\n`).size);
  });

  it('refuses a pack that is corrupt, cut short, or over a cap', async () => {
    const blob = gitObject('blob', Buffer.from('hello\n'.repeat(1000)));
    const pack = await packBuffer([blob]);
    const flipped = Buffer.from(pack);
    flipped[flipped.length - 1] ^= 1;
    await expect(readPack(flipped)).rejects.toThrow(/checksum/);
    await expect(readPack(pack.subarray(0, pack.length - 5))).rejects.toThrow(/ends early/);
    await expect(readPack(pack.subarray(0, 20))).rejects.toThrow(PackError);
    await expect(readPack(Buffer.from('JUNKJUNKJUNKJUNK'))).rejects.toThrow(/not a packfile/);
    await expect(readPack(pack, { limits: { maxObjectBytes: 100 } })).rejects.toThrow(/larger than/);
    await expect(readPack(pack, { limits: { maxPackBytes: 50 } })).rejects.toThrow(/larger than/);
    await expect(readPack(pack, { limits: { maxObjects: 0 } })).rejects.toThrow(/at most 0 objects/);
    const corrupt = Buffer.from(pack);
    corrupt[16] ^= 0xff;
    await expect(readPack(corrupt)).rejects.toThrow(PackError);
    expect((await readPack(pack)).get(blob.oid)?.body.equals(blob.body)).toBe(true);
  });

  it('applies deltas exactly, and refuses one that reads out of bounds', () => {
    const base = Buffer.from('0123456789');
    // Base size 10, result 7: copy 4 bytes from offset 2, then insert "abc".
    const delta = Buffer.from([10, 7, 0x80 | 0x01 | 0x10, 2, 4, 3, ...Buffer.from('abc')]);
    expect(applyDelta(base, delta).toString()).toBe('2345abc');
    expect(() => applyDelta(base, Buffer.from([10, 4, 0x80 | 0x01 | 0x10, 8, 4]))).toThrow(/out of bounds/);
    expect(() => applyDelta(base, Buffer.from([9, 1, 1, 0x61]))).toThrow(/base/);
    expect(() => applyDelta(base, Buffer.from([10, 2, 1, 0x61]))).toThrow(/wrong size/);
    expect(() => applyDelta(base, Buffer.from([10, 1, 0]))).toThrow(/reserved/);
    expect(() => applyDelta(base, Buffer.from([10, 0x80, 0x80, 0x01]), 100)).toThrow(/larger than/);
  });
});
