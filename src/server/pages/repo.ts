import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageRevisions } from '@/db/schema';
import { pageRepo } from '../git/repo';
import { type Commit, type EditKind, type GitObjectType, parseCommit, parseTree } from './git-objects';
import { diffFile, type FileDiff, type Version } from './merge';

/** Reading a page repo, through its `GitRepo` (`git/repo.ts`). Anything that writes is in `commit.ts`. */

export type Reader = Pick<Database, 'select' | 'execute'>;

export { readHead, toBytes } from '../git/repo';

export async function readObject(
  db: Reader,
  paperId: string,
  oid: string,
): Promise<{ type: GitObjectType; body: Buffer } | null> {
  const [found] = (await pageRepo(db, paperId).read([oid])).values();
  return found ?? null;
}

async function mustRead(db: Reader, paperId: string, oid: string, type: GitObjectType): Promise<Buffer> {
  const found = await readObject(db, paperId, oid);
  if (!found || found.type !== type) throw new Error(`page ${paperId} has no ${type} ${oid}`);
  return found.body;
}

export async function readCommit(db: Reader, paperId: string, oid: string): Promise<Commit> {
  return parseCommit(await mustRead(db, paperId, oid, 'commit'));
}

/** A commit if `oid` is one in this page's repo, for ids that come from outside. */
export async function findCommit(db: Reader, paperId: string, oid: string): Promise<Commit | null> {
  if (!/^[0-9a-f]{40}$/.test(oid)) return null;
  const found = await readObject(db, paperId, oid);
  return found?.type === 'commit' ? parseCommit(found.body) : null;
}

/** Every file in a tree, by path. */
export async function readFiles(db: Reader, paperId: string, tree: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of parseTree(await mustRead(db, paperId, tree, 'tree'))) {
    if (entry.isTree) {
      for (const [path, oid] of await readFiles(db, paperId, entry.oid, `${prefix}${entry.name}/`)) {
        files.set(path, oid);
      }
    } else {
      files.set(`${prefix}${entry.name}`, entry.oid);
    }
  }
  return files;
}

export async function readText(db: Reader, paperId: string, blob: string | undefined): Promise<Version> {
  if (!blob) return null;
  return (await mustRead(db, paperId, blob, 'blob')).toString('utf8');
}

export interface ChangedFile {
  path: string;
  before?: string;
  after?: string;
}

/** The files that differ between two trees, in a stable order. */
export function changedFiles(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): ChangedFile[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((path) => before.get(path) !== after.get(path))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map((path) => ({ path, before: before.get(path), after: after.get(path) }));
}

/** What changed between two commits of a page, or since nothing at all when `from` is `null`. */
export async function diffCommits(
  paperId: string,
  from: string | null,
  to: string,
  database: Database = getDb(),
): Promise<FileDiff[] | null> {
  const [start, end] = await Promise.all([
    from ? findCommit(database, paperId, from) : null,
    findCommit(database, paperId, to),
  ]);
  if (!end || (from && !start)) return null;
  const before = start ? await readFiles(database, paperId, start.tree) : new Map<string, string>();
  const after = await readFiles(database, paperId, end.tree);
  const diffs: FileDiff[] = [];
  for (const file of changedFiles(before, after)) {
    diffs.push(
      diffFile(
        file.path,
        await readText(database, paperId, file.before),
        await readText(database, paperId, file.after),
      ),
    );
  }
  return diffs;
}

export interface PublicRevision {
  seq: number;
  oid: string;
  authorId: string;
  kind: EditKind;
  summary: string;
  paths: string[];
  bytesDelta: number;
  /** Addresses that back the change up. */
  evidence: string[];
  at: Date;
}

/** A page's history, newest first. **Public:** it never selects `account_id`. */
export async function pageHistory(
  paperId: string,
  options: { limit?: number; beforeSeq?: number; database?: Database } = {},
): Promise<PublicRevision[]> {
  const { limit = 50, beforeSeq, database = getDb() } = options;
  const rows = await database
    .select({
      seq: pageRevisions.seq,
      oid: pageRevisions.oid,
      authorId: pageRevisions.authorId,
      kind: pageRevisions.kind,
      summary: pageRevisions.summary,
      paths: pageRevisions.paths,
      bytesDelta: pageRevisions.bytesDelta,
      evidence: pageRevisions.evidence,
      at: pageRevisions.at,
    })
    .from(pageRevisions)
    .where(and(eq(pageRevisions.paperId, paperId), beforeSeq ? lt(pageRevisions.seq, beforeSeq) : undefined))
    .orderBy(desc(pageRevisions.seq))
    .limit(limit);
  return rows.map((row) => ({ ...row, oid: row.oid.toString('hex') }));
}
