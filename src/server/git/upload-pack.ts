import { writePack } from './pack';
import { BAND_DATA, BAND_ERROR, DELIM, FLUSH, pkt, PktError, type PktReader, pktText, sideband } from './pkt-line';
import type { GitRepo } from './repo';
import {
  ancestors,
  checkWants,
  type CommitGraph,
  commonCommits,
  FetchError,
  loadCommitGraph,
  objectsToSend,
  readObjects,
} from './walk';

/**
 * git-upload-pack, the server side of `git clone` and `git fetch` (gitprotocol-v2(5), gitprotocol-pack(5)),
 * over any transport: packets in through a `PktReader`, bytes out as an async generator. Over HTTP each POST
 * is one stateless request (`advertisement` on `GET info/refs`, then `uploadPackRequest`); over SSH one byte
 * stream carries a whole session (`uploadPackSession`).
 *
 * Protocol v2 is what git has spoken by default since 2.29: `ls-refs` and `fetch`. Versions 0 and 1 (the
 * same thing, but for a version line) are here for older clients and libraries, with `multi_ack_detailed`
 * negotiation. Neither offers shallow clones, filters, tags or deltas; git refuses `--depth` up front and
 * ignores `--filter` when the server does not list them.
 */

export type ProtocolVersion = 0 | 1 | 2;

export const AGENT = 'agent=potentialpaper';
const MAIN = 'refs/heads/main';
const ZERO_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;

/** The version a client asks for, in the `Git-Protocol` header (HTTP) or `GIT_PROTOCOL` variable (SSH). */
export function protocolVersion(gitProtocol: string | null | undefined): ProtocolVersion {
  const versions = (gitProtocol ?? '')
    .split(':')
    .map((kv) => /^version=(\d+)$/.exec(kv.trim())?.[1])
    .filter(Boolean)
    .map(Number);
  // Git sends one; a client listing several gets the highest this server speaks.
  if (versions.includes(2)) return 2;
  if (versions.includes(1)) return 1;
  return 0;
}

const V0_CAPABILITIES = [
  'multi_ack_detailed',
  'side-band-64k',
  'no-progress',
  `symref=HEAD:${MAIN}`,
  'object-format=sha1',
];

/** What the server says first: its capabilities (v2), or its refs with its capabilities (v0, v1). */
export async function advertisement(repo: GitRepo, version: ProtocolVersion): Promise<Buffer> {
  if (version === 2) return v2Capabilities();
  const head = await repo.head();
  const caps = [...V0_CAPABILITIES, AGENT].join(' ');
  const lines = [
    ...(version === 1 ? [pkt('version 1\n')] : []),
    ...(head
      ? [pkt(`${head} HEAD\0${caps}\n`), pkt(`${head} ${MAIN}\n`)]
      : [pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`)]),
    FLUSH,
  ];
  return Buffer.concat(lines);
}

function v2Capabilities(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`${AGENT}\n`),
    pkt('ls-refs\n'),
    pkt('fetch\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

/** One stateless request, the body of an HTTP POST to `git-upload-pack`. */
export async function* uploadPackRequest(
  repo: GitRepo,
  input: PktReader,
  version: ProtocolVersion,
): AsyncGenerator<Buffer> {
  try {
    if (version === 2) yield* v2Command(repo, input);
    else yield* v0Fetch(repo, input, true);
  } catch (err) {
    yield* failure(err);
  }
}

/**
 * A whole session on a byte stream that stays open, as `git-upload-pack` runs over SSH: the advertisement,
 * then commands until the client hangs up (v2), or one fetch (v0, v1).
 */
export async function* uploadPackSession(
  repo: GitRepo,
  input: PktReader,
  version: ProtocolVersion,
): AsyncGenerator<Buffer> {
  try {
    yield await advertisement(repo, version);
    if (version === 2) {
      for (;;) {
        const done = yield* v2Command(repo, input);
        if (done) return;
      }
    }
    yield* v0Fetch(repo, input, false);
  } catch (err) {
    yield* failure(err);
  }
}

/** A refusal or a fault, as git shows it: `ERR` before anything else, or the error band during a pack. */
function* failure(err: unknown): Generator<Buffer> {
  if (err instanceof PackStarted) {
    // A pack sent raw (v0 without side-band) has no channel left to say anything on.
    if (!err.sidebanded) throw err.cause;
    yield* sideband(BAND_ERROR, Buffer.from(`${message(err.cause)}\n`));
    yield FLUSH;
    if (!(err.cause instanceof FetchError)) throw err.cause;
    return;
  }
  yield pkt(`ERR ${message(err)}\n`);
  if (!(err instanceof FetchError || err instanceof PktError)) throw err;
}

function message(err: unknown): string {
  return err instanceof FetchError || err instanceof PktError ? err.message : 'internal error';
}

/** Thrown out of a pack that has started, so the error goes on the error band. */
class PackStarted extends Error {
  constructor(
    readonly cause: unknown,
    readonly sidebanded: boolean,
  ) {
    super('pack failed');
  }
}

// ---------------------------------------------------------------------------------------------- v2

/** One v2 command. Returns true when the client has ended the session (a flush, or the end of input). */
async function* v2Command(repo: GitRepo, input: PktReader): AsyncGenerator<Buffer, boolean> {
  const first = await input.readSection();
  if (!first || first.lines.length === 0) return true;
  const command = /^command=(.+)$/.exec(first.lines[0])?.[1];
  if (!command) throw new FetchError('expected a command');
  for (const cap of first.lines.slice(1)) {
    if (cap.startsWith('object-format=') && cap !== 'object-format=sha1') {
      throw new FetchError(`unsupported object format ${cap.slice('object-format='.length)}`);
    }
  }
  const args = first.end === 'delim' ? await input.readSection() : { lines: [], end: 'flush' as const };
  if (!args || args.end !== 'flush') throw new FetchError('expected a flush after the arguments');
  if (command === 'ls-refs') yield await lsRefs(repo, args.lines);
  else if (command === 'fetch') yield* v2Fetch(repo, args.lines);
  else throw new FetchError(`unknown command ${command}`);
  return false;
}

async function lsRefs(repo: GitRepo, args: readonly string[]): Promise<Buffer> {
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const symrefs = args.includes('symrefs');
  for (const arg of args) {
    if (!['symrefs', 'peel'].includes(arg) && !arg.startsWith('ref-prefix ')) {
      throw new FetchError(`ls-refs: unexpected argument ${arg}`);
    }
  }
  const head = await repo.head();
  const wanted = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: Buffer[] = [];
  if (head) {
    if (wanted('HEAD')) lines.push(pkt(`${head} HEAD${symrefs ? ` symref-target:${MAIN}` : ''}\n`));
    if (wanted(MAIN)) lines.push(pkt(`${head} ${MAIN}\n`));
  }
  return Buffer.concat([...lines, FLUSH]);
}

/** Arguments a client may send without asking: they change nothing for a pack with no deltas or tags. */
const IGNORED_FETCH_ARGS = new Set(['thin-pack', 'no-progress', 'include-tag', 'ofs-delta']);

async function* v2Fetch(repo: GitRepo, args: readonly string[]): AsyncGenerator<Buffer> {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  for (const arg of args) {
    const [name, value] = splitArg(arg);
    if (name === 'want' && OID.test(value)) wants.push(value);
    else if (name === 'have' && OID.test(value)) haves.push(value);
    else if (arg === 'done') done = true;
    else if (IGNORED_FETCH_ARGS.has(arg)) continue;
    else throw new FetchError(`fetch: ${unsupported(name)}`);
  }
  const [head, graph] = await Promise.all([repo.head(), loadCommitGraph(repo)]);
  checkWants(graph, head, wants);
  const common = commonCommits(graph, haves);

  if (!done) {
    // Any common commit is as good a base as any other here, so one is enough to stop negotiating.
    if (common.length === 0) {
      yield Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]);
      return;
    }
    yield Buffer.concat([pkt('acknowledgments\n'), ...common.map((oid) => pkt(`ACK ${oid}\n`)), pkt('ready\n'), DELIM]);
  }
  yield* packSection(repo, graph, wants, common, true);
}

function splitArg(arg: string): [string, string] {
  const space = arg.indexOf(' ');
  return space === -1 ? [arg, ''] : [arg.slice(0, space), arg.slice(space + 1)];
}

function unsupported(name: string): string {
  if (['shallow', 'deepen', 'deepen-since', 'deepen-not', 'deepen-relative'].includes(name)) {
    return 'shallow clones are not supported; clone the whole history';
  }
  if (name === 'filter') return 'partial clones (--filter) are not supported';
  return `unexpected argument ${name}`;
}

/** The pack: on band 1 inside `packfile` (v2) or after the negotiation (v0 with side-band-64k), or raw. */
async function* packSection(
  repo: GitRepo,
  graph: CommitGraph,
  wants: readonly string[],
  common: readonly string[],
  sidebanded: boolean,
  v2 = true,
): AsyncGenerator<Buffer> {
  const objects = await objectsToSend(repo, graph, wants, common);
  if (v2) yield pkt('packfile\n');
  try {
    // Small chunks are gathered up to a full packet, so a pack of many small objects is not a packet each.
    let pending: Buffer[] = [];
    let size = 0;
    const room = 65515;
    for await (const chunk of writePack(objects.length, readObjects(repo, objects))) {
      if (!sidebanded) {
        yield chunk;
        continue;
      }
      pending.push(chunk);
      size += chunk.length;
      if (size >= room) {
        yield Buffer.concat([...sideband(BAND_DATA, Buffer.concat(pending))]);
        pending = [];
        size = 0;
      }
    }
    if (sidebanded) {
      if (size) yield Buffer.concat([...sideband(BAND_DATA, Buffer.concat(pending))]);
      yield FLUSH;
    }
  } catch (err) {
    throw new PackStarted(err, sidebanded);
  }
}

// ---------------------------------------------------------------------------------------- v0 and v1

/**
 * A v0 fetch. The wants come first, with the client's capabilities on the first line, then rounds of haves,
 * each ended by a flush, until `done`. On a stateless transport each request repeats the wants and the
 * commits found in common so far, and ends after one round. This follows upload-pack.c's answers.
 */
async function* v0Fetch(repo: GitRepo, input: PktReader, stateless: boolean): AsyncGenerator<Buffer> {
  const first = await input.readSection();
  // A client that already has everything sends a flush (or hangs up) instead of wants.
  if (!first || first.lines.length === 0) return;
  if (first.end !== 'flush') throw new FetchError('expected a flush after the wants');
  const wants: string[] = [];
  const caps = new Set<string>();
  for (const [i, line] of first.lines.entries()) {
    const [name, rest] = splitArg(line);
    if (name !== 'want') throw new FetchError(unsupported(name));
    const [oid, ...more] = rest.split(' ');
    if (!OID.test(oid)) throw new FetchError(`bad want ${oid}`);
    wants.push(oid);
    if (i === 0) for (const cap of more) caps.add(cap);
  }
  const multiAck = caps.has('multi_ack_detailed');
  const sidebanded = caps.has('side-band-64k');

  const [head, graph] = await Promise.all([repo.head(), loadCommitGraph(repo)]);
  checkWants(graph, head, wants);

  const common: string[] = [];
  const known = new Set<string>();
  // Whether every want has a common commit among its ancestors, so a pack can be cut against them.
  const wantHistories = wants.map((want) => ancestors(graph, [want]));
  let canGiveUp = false;
  const okToGiveUp = () => {
    canGiveUp ||= wantHistories.every((history) => common.some((oid) => history.has(oid)));
    return canGiveUp;
  };
  let gotCommon = false;
  let gotOther = false;
  let last = '';

  for (;;) {
    const p = await input.read();
    if (!p) {
      if (stateless) return;
      throw new FetchError('the client hung up during negotiation');
    }
    if (p.kind === 'flush') {
      const answers: Buffer[] = [];
      if (multiAck && gotCommon && !gotOther && okToGiveUp()) answers.push(pkt(`ACK ${last} ready\n`));
      if (common.length === 0 || multiAck) answers.push(pkt('NAK\n'));
      yield Buffer.concat(answers);
      if (stateless) return;
      gotCommon = false;
      gotOther = false;
      continue;
    }
    const line = pktText(p);
    const have = line && /^have ([0-9a-f]{40})$/.exec(line)?.[1];
    if (have) {
      if (!graph.has(have)) {
        gotOther = true;
        if (multiAck && okToGiveUp()) yield pkt(`ACK ${have} ready\n`);
        continue;
      }
      gotCommon = true;
      last = have;
      if (!known.has(have)) {
        known.add(have);
        common.push(have);
      }
      if (multiAck) yield pkt(`ACK ${have} common\n`);
      else if (common.length === 1) yield pkt(`ACK ${have}\n`);
      continue;
    }
    if (line !== 'done') throw new FetchError(`expected have or done, got ${JSON.stringify(line)}`);
    if (common.length === 0) yield pkt('NAK\n');
    else if (multiAck) yield pkt(`ACK ${last}\n`);
    break;
  }
  yield* packSection(repo, graph, wants, common, sidebanded, false);
}
