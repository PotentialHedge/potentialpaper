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
}

export const SYSTEM_AUTHOR_ID = 'potentialpaper';

function signature(id: string, at: Date): string {
  return `${id} <${id}@users.invalid> ${Math.floor(at.getTime() / 1000)} +0000`;
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
  ];
  return Buffer.from(`${lines.join('\n')}\n`);
}

export function parseCommit(body: Buffer): Commit {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = text.slice(0, split).split('\n');
  const field = (name: string) => head.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1);
  const author = /^(\S+) <[^>]*> (\d+) \+0000$/.exec(field('author') ?? '');
  const tree = field('tree');
  if (!tree || !author) throw new Error('malformed commit');

  const message = text.slice(split + 2);
  const end = message.indexOf('\n\n');
  const trailers = new Map(
    message
      .slice(end + 2)
      .trim()
      .split('\n')
      .map((line) => {
        const colon = line.indexOf(': ');
        return [line.slice(0, colon), line.slice(colon + 2)] as const;
      }),
  );
  const kind = trailers.get('Edit-Kind') as EditKind | undefined;
  if (!kind || !EDIT_KINDS.includes(kind)) throw new Error('commit has no Edit-Kind');
  return {
    tree,
    parent: field('parent') ?? null,
    authorId: author[1],
    at: new Date(Number(author[2]) * 1000),
    summary: message.slice(0, end),
    kind,
    reverts: trailers.get('Reverts'),
    bot: trailers.get('Bot') === 'true',
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
