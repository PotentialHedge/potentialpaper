import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { packBuffer, packObjectHeader } from '@/server/git/pack';
import {
  BAND_DATA,
  DELIM,
  FLUSH,
  pkt,
  PktError,
  PktReader,
  pktText,
  readAllPkts,
  sideband,
} from '@/server/git/pkt-line';
import { type GitRepo, memoryRepo } from '@/server/git/repo';
import { advertisement, protocolVersion, uploadPackRequest, uploadPackSession } from '@/server/git/upload-pack';
import { buildTrees, encodeCommit, type GitObject, gitObject, type GitObjectType } from '@/server/pages/git-objects';

function git(args: string[], cwd?: string, input?: Buffer): string {
  return execFileSync('git', args, { cwd, input, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
}

function gitAsync(args: string[], cwd?: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout),
    );
  });
}

const dirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-protocol-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function* chunks(bytes: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function collect(output: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const chunk of output) out.push(chunk);
  return Buffer.concat(out);
}

/**
 * Puts a pack into an empty repo with `git index-pack`, which checks every object and the trailer, and with
 * `strict` also that the pack is whole (no object names one that isn't there).
 */
function indexPack(pack: Buffer, strict = true): { repo: string; oids: string[] } {
  const repo = workDir();
  git(['init', '-q', '--bare', repo]);
  const file = join(repo, 'objects/pack/test.pack');
  writeFileSync(file, pack);
  git(['index-pack', ...(strict ? ['--strict'] : []), file], repo);
  const oids = git(['verify-pack', '-v', file.replace(/\.pack$/, '.idx')], repo)
    .split('\n')
    .filter((line) => /^[0-9a-f]{40} /.test(line))
    .map((line) => line.slice(0, 40));
  return { repo, oids };
}

describe('pkt-line', () => {
  it('frames data as git does', () => {
    expect(pkt('a\n').toString()).toBe('0006a\n');
    expect(pkt('').toString()).toBe('0004');
    expect(FLUSH.toString() + DELIM.toString()).toBe('00000001');
    expect(() => pkt(Buffer.alloc(65517))).toThrow(PktError);
    expect(pkt(Buffer.alloc(65516)).subarray(0, 4).toString()).toBe('fff0');
  });

  it('reads back what it writes, however the stream is cut', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.uint8Array({ maxLength: 300 }), fc.constantFrom('flush', 'delim', 'end'))),
        fc.integer({ min: 1, max: 50 }),
        async (packets, size) => {
          const bytes = Buffer.concat(
            packets.map((p) =>
              p === 'flush' ? FLUSH : p === 'delim' ? DELIM : p === 'end' ? Buffer.from('0002') : pkt(Buffer.from(p)),
            ),
          );
          const reader = new PktReader(chunks(bytes, size));
          for (const p of packets) {
            const read = await reader.read();
            if (typeof p === 'string') expect(read!.kind).toBe(p === 'end' ? 'response-end' : p);
            else expect(read).toEqual({ kind: 'data', data: Buffer.from(p) });
          }
          expect(await reader.read()).toBeNull();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('refuses malformed input', async () => {
    for (const bad of ['000', 'zzzz', '0003', '0009abc', 'fff1' + 'x'.repeat(65520)]) {
      await expect(readAllPkts(Buffer.from(bad))).rejects.toThrow(PktError);
    }
    expect(pktText((await readAllPkts(pkt('want x\n')))[0])).toBe('want x');
  });

  it('cuts side-band data into full packets', () => {
    const data = Buffer.alloc(65515 * 2 + 10, 7);
    const packets = [...sideband(BAND_DATA, data)];
    expect(packets.map((p) => p.length)).toEqual([65520, 65520, 15]);
    expect(packets.every((p) => p[4] === BAND_DATA)).toBe(true);
  });
});

describe('pack writer', () => {
  it('writes sizes as git reads them', () => {
    expect([...packObjectHeader('blob', 0)]).toEqual([0x30]);
    expect([...packObjectHeader('blob', 15)]).toEqual([0x3f]);
    expect([...packObjectHeader('commit', 16)]).toEqual([0x90, 0x01]);
    expect([...packObjectHeader('tree', 2047)]).toEqual([0xaf, 0x7f]);
  });

  it('makes packs git index-pack accepts', async () => {
    const blobs = [0, 1, 15, 16, 127, 2047, 2048, 300_000].map((n) =>
      gitObject('blob', Buffer.from('x'.repeat(n) + String(n))),
    );
    blobs.push(gitObject('blob', Buffer.alloc(0)), gitObject('blob', Buffer.from([0, 255, 1, 2])));
    const files = new Map(blobs.map((b, i) => [`dir${i % 3}/file${i}`, b.oid]));
    const { root, trees } = buildTrees(files);
    const commit = gitObject(
      'commit',
      encodeCommit({ tree: root, parent: null, authorId: 'u_test', at: new Date(0), summary: 'Hi', kind: 'edit' }),
    );
    const all = [commit, ...trees, ...new Map(blobs.map((b) => [b.oid, b])).values()];
    const { repo, oids } = indexPack(await packBuffer(all));
    expect(new Set(oids)).toEqual(new Set(all.map((o) => o.oid)));
    for (const object of all) {
      expect(git(['cat-file', '-t', object.oid], repo).trim()).toBe(object.type);
      expect(execFileSync('git', ['cat-file', object.type, object.oid], { cwd: repo }).equals(object.body)).toBe(true);
    }
  });

  it('makes an empty pack', async () => {
    expect(indexPack(await packBuffer([])).oids).toEqual([]);
  });
});

/** A linear history in memory: commit `i` changes `community/10-summary.md` and adds `notes/<i>.md`. */
function history(length: number): { repo: GitRepo; commits: GitObject[]; objects: Map<string, GitObject> } {
  const objects = new Map<string, GitObject>();
  const put = (type: GitObjectType, body: Buffer) => {
    const object = gitObject(type, body);
    objects.set(object.oid, object);
    return object;
  };
  const files = new Map<string, string>([['.potentialpaper/metadata.json', put('blob', Buffer.from('{}\n')).oid]]);
  const commits: GitObject[] = [];
  for (let i = 0; i < length; i += 1) {
    files.set('community/10-summary.md', put('blob', Buffer.from(`# Summary\n\nVersion ${i}.\n`)).oid);
    files.set(`notes/${String(i).padStart(3, '0')}.md`, put('blob', Buffer.from(`Note ${i}\n`)).oid);
    const { root, trees } = buildTrees(files);
    for (const tree of trees) objects.set(tree.oid, tree);
    const body = encodeCommit({
      tree: root,
      parent: commits.at(-1)?.oid ?? null,
      authorId: 'u_test',
      at: new Date(1_700_000_000_000 + i * 1000),
      summary: `Edit ${i}`,
      kind: 'edit',
    });
    commits.push(put('commit', body));
  }
  return { repo: memoryRepo(commits.at(-1)?.oid ?? null, objects), commits, objects };
}

function v2Request(command: string, args: string[]): Buffer {
  return Buffer.concat([
    pkt(`command=${command}\n`),
    pkt('agent=test\n'),
    pkt('object-format=sha1\n'),
    DELIM,
    ...args.map((a) => pkt(`${a}\n`)),
    FLUSH,
  ]);
}

/** The pack in a v2 fetch response, taken off band 1. */
async function packOf(response: Buffer): Promise<{ lines: string[]; pack: Buffer }> {
  const lines: string[] = [];
  const pack: Buffer[] = [];
  let inPack = false;
  for (const p of await readAllPkts(response)) {
    if (p.kind !== 'data') continue;
    if (inPack) {
      expect(p.data[0]).toBe(BAND_DATA);
      pack.push(p.data.subarray(1));
    } else {
      lines.push(pktText(p)!);
      if (lines.at(-1) === 'packfile') inPack = true;
    }
  }
  return { lines, pack: Buffer.concat(pack) };
}

describe('upload-pack, protocol v2', () => {
  it('reads the version a client asks for', () => {
    expect(protocolVersion('version=2')).toBe(2);
    expect(protocolVersion('foo=bar:version=1')).toBe(1);
    expect(protocolVersion(null)).toBe(0);
    expect(protocolVersion('version=3')).toBe(0);
  });

  it('lists its capabilities and its refs', async () => {
    const { repo, commits } = history(2);
    const caps = (await readAllPkts(await advertisement(repo, 2))).map(pktText);
    expect(caps).toEqual(['version 2', 'agent=potentialpaper', 'ls-refs', 'fetch', 'object-format=sha1', null]);
    const head = commits[1].oid;
    const refs = async (args: string[]) =>
      (await readAllPkts(await collect(uploadPackRequest(repo, new PktReader(v2Request('ls-refs', args)), 2)))).map(
        pktText,
      );
    expect(await refs(['symrefs', 'peel', 'ref-prefix HEAD', 'ref-prefix refs/heads/'])).toEqual([
      `${head} HEAD symref-target:refs/heads/main`,
      `${head} refs/heads/main`,
      null,
    ]);
    expect(await refs(['ref-prefix refs/tags/'])).toEqual([null]);
  });

  it('sends everything for a clone and only what is new for a fetch', async () => {
    const { repo, commits, objects } = history(5);
    const clone = await packOf(
      await collect(uploadPackRequest(repo, new PktReader(v2Request('fetch', [`want ${commits[4].oid}`, 'done'])), 2)),
    );
    expect(clone.lines).toEqual(['packfile']);
    expect(new Set(indexPack(clone.pack).oids)).toEqual(new Set(objects.keys()));

    // Knowing commit 2, the client gets commits 3 and 4, their root and changed trees, and two new blobs each.
    const fetch = await packOf(
      await collect(
        uploadPackRequest(
          repo,
          new PktReader(
            v2Request('fetch', [`want ${commits[4].oid}`, `have ${commits[2].oid}`, `have ${'f'.repeat(40)}`]),
          ),
          2,
        ),
      ),
    );
    expect(fetch.lines).toEqual(['acknowledgments', `ACK ${commits[2].oid}`, 'ready', 'packfile']);
    const sent = indexPack(fetch.pack, false).oids;
    expect(sent).toContain(commits[3].oid);
    expect(sent).not.toContain(commits[2].oid);
    // 2 commits, each with a root, community/ and notes/ tree and two blobs.
    expect(sent).toHaveLength(2 * (1 + 3 + 2));
  });

  it('negotiates when nothing is in common, and refuses what it cannot do', async () => {
    const { repo, commits } = history(2);
    const run = async (args: string[]) =>
      (await readAllPkts(await collect(uploadPackRequest(repo, new PktReader(v2Request('fetch', args)), 2)))).map(
        pktText,
      );
    expect(await run([`want ${commits[1].oid}`, `have ${'a'.repeat(40)}`])).toEqual(['acknowledgments', 'NAK', null]);
    expect(await run([`want ${'a'.repeat(40)}`, 'done'])).toEqual([`ERR upload-pack: not our ref ${'a'.repeat(40)}`]);
    expect(await run([`want ${commits[1].oid}`, 'deepen 1', 'done'])).toEqual([
      'ERR fetch: shallow clones are not supported; clone the whole history',
    ]);
    expect(await run([`want ${commits[1].oid}`, 'filter blob:none', 'done'])).toEqual([
      'ERR fetch: partial clones (--filter) are not supported',
    ]);
  });
});

describe('real git against the session', () => {
  // git:// is the plainest stateful transport: one TCP connection, a request line, then the same session SSH
  // would carry. So this drives `uploadPackSession` as SSH will.
  let server: Server;
  let port: number;
  let current: GitRepo;

  beforeAll(async () => {
    server = createServer((socket: Socket) => {
      void (async () => {
        const reader = new PktReader(socket);
        const request = await reader.read();
        if (!request || request.kind !== 'data') return socket.destroy();
        // `git-upload-pack /path\0host=…\0` and, for v2, `\0version=2\0`.
        const extra = request.data.toString('latin1').split('\0').slice(2).filter(Boolean).join(':');
        for await (const chunk of uploadPackSession(current, reader, protocolVersion(extra))) {
          if (!socket.write(chunk)) await new Promise((resolve) => socket.once('drain', resolve));
        }
        socket.end();
      })().catch(() => socket.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  for (const version of [2, 0] as const) {
    it(`clones and fetches over protocol v${version}`, async () => {
      const long = history(40);
      current = memoryRepo(long.commits[29].oid, long.objects);
      const clone = join(workDir(), 'page');
      const config = ['-c', `protocol.version=${version}`];
      await gitAsync([...config, 'clone', '-q', `git://127.0.0.1:${port}/page.git`, clone]);
      expect(git(['rev-parse', 'HEAD'], clone).trim()).toBe(long.commits[29].oid);
      expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone).trim()).toBe('main');
      git(['fsck', '--full', '--strict', '--no-dangling'], clone);

      current = memoryRepo(long.commits[39].oid, long.objects);
      await gitAsync([...config, 'fetch', '-q', 'origin'], clone);
      expect(git(['rev-parse', 'origin/main'], clone).trim()).toBe(long.commits[39].oid);
      git(['fsck', '--full', '--strict', '--no-dangling'], clone);
      expect(readFileSync(join(clone, 'community/10-summary.md'), 'utf8')).toContain('Version 29.');

      await expect(
        gitAsync([
          ...config,
          'clone',
          '-q',
          '--depth=1',
          `git://127.0.0.1:${port}/page.git`,
          join(clone, '../shallow'),
        ]),
      ).rejects.toThrow(/shallow|depth/i);
    });
  }
});
