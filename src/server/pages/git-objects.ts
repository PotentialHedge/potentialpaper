import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/**
 * Git's object format: bytes in, bytes and ids out, with no database. `git fsck --strict` is the test of
 * everything here (`tests/integration/page-store.test.ts`). Ids are lower-case hex outside the database.
 */

export type GitObjectType = 'blob' | 'tree' | 'commit';

export interface GitObject {
  oid: string;
  type: GitObjectType;
  body: Buffer;
}

function header(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`);
}

export function gitObject(type: GitObjectType, body: Buffer): GitObject {
  const oid = createHash('sha1').update(header(type, body.length)).update(body).digest('hex');
  return { oid, type, body };
}

/** The bytes of a loose object file, which is also what the dumb HTTP protocol serves. */
export function looseObject(type: GitObjectType, body: Buffer): Buffer {
  return deflateSync(Buffer.concat([header(type, body.length), body]));
}

export interface TreeEntry {
  name: string;
  isTree: boolean;
  oid: string;
}

const FILE_MODE = '100644';
const TREE_MODE = '40000';

/**
 * Git sorts entries by raw bytes, comparing a directory as `name/`. Any other order, such as a locale's,
 * makes a repo that clones but fails `git fsck`.
 */
function sortKey({ name, isTree }: TreeEntry): Buffer {
  return Buffer.from(isTree ? `${name}/` : name);
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  return Buffer.concat(
    sorted.flatMap((e) => [Buffer.from(`${e.isTree ? TREE_MODE : FILE_MODE} ${e.name}\0`), Buffer.from(e.oid, 'hex')]),
  );
}

export function parseTree(body: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let at = 0; at < body.length;) {
    const space = body.indexOf(0x20, at);
    const nul = body.indexOf(0, space);
    entries.push({
      name: body.toString('utf8', space + 1, nul),
      isTree: body.toString('latin1', at, space) === TREE_MODE,
      oid: body.toString('hex', nul + 1, nul + 21),
    });
    at = nul + 21;
  }
  return entries;
}

export const EDIT_KINDS = ['edit', 'revert'] as const;
export type EditKind = (typeof EDIT_KINDS)[number];

export interface Commit {
  tree: string;
  parent: string | null;
  /** The public id of whoever wrote it: `u_7k3xq2mf`, or `potentialpaper` for the system. */
  authorId: string;
  /** Whole seconds, because a commit holds no more. */
  at: Date;
  summary: string;
  kind: EditKind;
  reverts?: string;
  bot?: boolean;
  /** Addresses that back the change up (`lib/evidence.ts`), one `Evidence:` trailer each. */
  evidence?: string[];
}

export const SYSTEM_AUTHOR_ID = 'potentialpaper';

function signature(id: string, at: Date): string {
  return `${id} <${identityEmail(id)}> ${Math.floor(at.getTime() / 1000)} +0000`;
}

/**
 * The summary has to be a single line (`cleanSummary`), which is what keeps trailers honest: it can never
 * reach the last paragraph, where `Bot: false` or `Edit-Kind: revert` would be read as a trailer.
 */
export function encodeCommit(commit: Commit): Buffer {
  const lines = [
    `tree ${commit.tree}`,
    ...(commit.parent ? [`parent ${commit.parent}`] : []),
    `author ${signature(commit.authorId, commit.at)}`,
    `committer ${signature(SYSTEM_AUTHOR_ID, commit.at)}`,
    '',
    commit.summary,
    '',
    `Edit-Kind: ${commit.kind}`,
    ...(commit.reverts ? [`Reverts: ${commit.reverts}`] : []),
    ...(commit.bot ? ['Bot: true'] : []),
    ...(commit.evidence ?? []).map((url) => `Evidence: ${url}`),
  ];
  return Buffer.from(`${lines.join('\n')}\n`);
}

export interface Signature {
  name: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  /** As git writes it, `+0000` or `-0130`. */
  zone: string;
}

const SIGNATURE = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/;

export function parseSignature(line: string): Signature | null {
  const match = SIGNATURE.exec(line);
  return match && { name: match[1], email: match[2], time: Number(match[3]), zone: match[4] };
}

/** The email in a commit signed by a public id (`u_…`, `a_…`, the system's). */
export function identityEmail(id: string): string {
  return `${id}@users.invalid`;
}

/** A commit object as git has it, before any meaning is read into its message. */
export interface CommitObject {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  /** Every header line's name, in order, continuation lines left out (`gpgsig`'s, say). */
  headers: string[];
  /** The `encoding` header, if there is one. */
  encoding: string | null;
  message: string;
}

export function parseCommitObject(body: Buffer): CommitObject {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = (split === -1 ? text : text.slice(0, split)).split('\n');
  const field = (name: string) => head.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1);
  const tree = field('tree');
  const author = parseSignature(field('author') ?? '');
  const committer = parseSignature(field('committer') ?? '');
  if (!tree || !author || !committer) throw new Error('malformed commit');
  return {
    tree,
    parents: head.filter((l) => l.startsWith('parent ')).map((l) => l.slice('parent '.length)),
    author,
    committer,
    headers: head.filter((l) => !l.startsWith(' ')).map((l) => l.slice(0, l.indexOf(' '))),
    encoding: field('encoding') ?? null,
    message: split === -1 ? '' : text.slice(split + 2),
  };
}

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*): (.*)$/;

/**
 * A message's summary (its first paragraph, as one line) and its trailers: the last paragraph, if there is
 * more than one and every line of it is a `Key: value`, as git reads them. Lines between are the body.
 */
export function parseMessage(message: string): { summary: string; trailers: [string, string][] } {
  const paragraphs = message
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const summary = (paragraphs[0] ?? '').replace(/\s*\n\s*/g, ' ');
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1].split('\n') : [];
  const pairs = last.map((line) => TRAILER.exec(line));
  const trailers = pairs.every((pair) => pair !== null)
    ? pairs.map((pair) => [pair![1], pair![2]] as [string, string])
    : [];
  return { summary, trailers };
}

/**
 * A commit's meaning for the site. Commits pushed from a git client have no `Edit-Kind:` trailer, and are
 * edits; their time is the committer's (a rebase keeps an older author date).
 */
export function parseCommit(body: Buffer): Commit {
  const raw = parseCommitObject(body);
  const { summary, trailers: pairs } = parseMessage(raw.message);
  const trailers = new Map(pairs);
  const evidence = pairs.filter(([key]) => key === 'Evidence').map(([, value]) => value);
  const kind = (trailers.get('Edit-Kind') ?? 'edit') as EditKind;
  if (!EDIT_KINDS.includes(kind)) throw new Error(`commit has an unknown Edit-Kind: ${kind}`);
  return {
    tree: raw.tree,
    parent: raw.parents[0] ?? null,
    authorId: raw.author.name,
    at: new Date(raw.committer.time * 1000),
    summary,
    kind,
    reverts: trailers.get('Reverts'),
    bot: trailers.get('Bot') === 'true',
    ...(evidence.length > 0 ? { evidence } : {}),
  };
}

/** Whole files by path to the objects holding them, as a repo at one commit. */
export type FileTree = ReadonlyMap<string, string>;

interface Directory {
  files: Map<string, string>;
  directories: Map<string, Directory>;
}

/** The tree objects for a set of files, root last. Directories exist only because a file is in them. */
export function buildTrees(files: FileTree): { root: string; trees: GitObject[] } {
  const top: Directory = { files: new Map(), directories: new Map() };
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let directory = top;
    for (const part of parts.slice(0, -1)) {
      let next = directory.directories.get(part);
      if (!next) {
        next = { files: new Map(), directories: new Map() };
        directory.directories.set(part, next);
      }
      directory = next;
    }
    directory.files.set(parts[parts.length - 1], oid);
  }

  const trees: GitObject[] = [];
  const write = (directory: Directory): string => {
    const entries: TreeEntry[] = [
      ...[...directory.files].map(([name, oid]) => ({ name, isTree: false, oid })),
      ...[...directory.directories].map(([name, child]) => ({ name, isTree: true, oid: write(child) })),
    ];
    const tree = gitObject('tree', encodeTree(entries));
    trees.push(tree);
    return tree.oid;
  };
  return { root: write(top), trees };
}
