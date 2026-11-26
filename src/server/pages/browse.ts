import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { ALL_PARTS } from '@/lib/kinds';
import { ApiError } from '../api/errors';
import { previewDemoSources } from '../demos/attach';
import { type GitRepo, memoryRepo, pageRepo } from '../git/repo';
import { findLfsObjects } from '../lfs';
import { historyWithHandles } from './edit';
import { buildTrees, type GitObject, gitObject, type GitObjectType, parseTree, type TreeEntry } from './git-objects';
import { renderMarkdown } from './markdown';
import { readCommit, readHead, type Reader } from './repo';
import { lfsKindOf, parseLfsPointer, sectionName } from './rules';
import { renderPart } from './sections';
import { firstCommitFiles } from './starter';

/**
 * A page's repo as the Repo tab shows it, GitHub's file browser in small: the latest commit, one folder at a time, its
 * README rendered under it, and one file at a time. Read when the tab opens (`GET /api/v1/repo`), never while the page
 * renders, so the page stays as fast and as cacheable as it was. A folder reads only the trees on the way to it, so a
 * page's thousands of `reviews/` files cost nothing until someone opens that folder.
 *
 * A paper nobody has edited or cloned has no repo. It shows the repo its first commit would start (`firstCommitFiles`,
 * the same function `commitPage` writes from), built in memory and never stored: the tree is the one that commit
 * would have.
 */

/** Text files are shown up to this size; beyond it, only linked. The site's own limit is 1 MB, in `demos/`. */
const MAX_SHOWN_BYTES = 1024 * 1024;

export interface RepoCommit {
  oid: string;
  seq: number;
  summary: string;
  /** The commit's author id (`u_…`, or `potentialpaper` for the system). */
  authorId: string;
  /** Who it is, as the history shows them: a handle, or the paper's author by name, or `null` for the system. */
  handle: string | null;
  authorName: string | null;
  at: Date;
}

export interface RepoEntry {
  name: string;
  path: string;
  type: 'folder' | 'file';
  /** A file's size; for a Git LFS file, the size of what it points at. */
  bytes: number | null;
  lfs: boolean;
  /** The newest commit that changed it, where one did (not in the placeholder). */
  last: { oid: string; summary: string; at: Date } | null;
}

export interface RepoFolder {
  /** The repo isn't there yet: this is what its first commit would write. */
  placeholder: boolean;
  head: RepoCommit | null;
  commits: number;
  path: string;
  entries: RepoEntry[];
  readme: { path: string; html: string } | null;
}

export type RepoFileView =
  | { type: 'markdown'; html: string }
  | { type: 'text'; text: string }
  | { type: 'lfs'; kind: 'pdf' | 'image'; sha256: string; bytes: number; url: string | null }
  | { type: 'binary' }
  | { type: 'large' };

export interface RepoFile {
  placeholder: boolean;
  path: string;
  oid: string;
  bytes: number;
  view: RepoFileView;
}

/** The repo to read, at the tree it shows. */
interface Source {
  repo: GitRepo;
  root: string;
  head: string | null;
}

/** The page's repo at its head, or the one its first commit would make. Writes nothing either way. */
export async function repoSource(db: Reader, pageId: string): Promise<Source> {
  const head = await readHead(db, pageId);
  if (head) return { repo: pageRepo(db, pageId), root: (await readCommit(db, pageId, head)).tree, head };
  return placeholderSource(await firstCommitFiles(db, pageId));
}

/** The repo made of these files alone, in memory: what a first commit of them stores, less the commit itself. */
export function placeholderSource(files: readonly [path: string, content: string][]): Source {
  const objects = new Map<string, { type: GitObjectType; body: Buffer }>();
  const add = (object: GitObject) => objects.set(object.oid, object);
  const tree = new Map<string, string>();
  for (const [path, content] of files) {
    const blob = gitObject('blob', Buffer.from(content));
    add(blob);
    tree.set(path, blob.oid);
  }
  const { root, trees } = buildTrees(tree);
  trees.forEach(add);
  return { repo: memoryRepo(null, objects), root, head: null };
}

async function readObject(repo: GitRepo, oid: string) {
  return (await repo.read([oid])).get(oid) ?? null;
}

/** The entries of folder `dir` (`''` for the root), or `null` if there is no such folder. */
async function listTree(repo: GitRepo, root: string, dir: string): Promise<TreeEntry[] | null> {
  let at = root;
  for (const name of dir ? dir.split('/') : []) {
    const tree = await readObject(repo, at);
    const entry = tree?.type === 'tree' ? parseTree(tree.body).find((e) => e.name === name) : undefined;
    if (!entry?.isTree) return null;
    at = entry.oid;
  }
  const tree = await readObject(repo, at);
  return tree?.type === 'tree' ? parseTree(tree.body) : null;
}

/** A path as the API takes it: no leading, trailing or doubled slashes, no `.` or `..`. */
export function cleanRepoPath(raw: string): string | null {
  const path = raw.replace(/^\/+|\/+$/g, '');
  if (path === '') return '';
  const parts = path.split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..') ? path : null;
}

const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/**
 * The newest commit that changed each of these paths, or anything under one of them, from the history's rows (each
 * row lists the paths its commit changed). One query, a short walk of a page's revisions per entry.
 */
async function lastCommits(
  database: Database,
  pageId: string,
  paths: readonly { path: string; folder: boolean }[],
): Promise<Map<string, { oid: string; summary: string; at: Date }>> {
  if (paths.length === 0) return new Map();
  const exact = paths.map((p) => p.path);
  // `like` patterns for a folder's contents, with the pattern characters in its name escaped.
  const under = paths.map((p) => (p.folder ? `${p.path.replace(/[\\%_]/g, '\\$&')}/%` : ''));
  const rows = await database.execute<{ path: string; oid: Buffer; summary: string; at: Date | string }>(sql`
    select e.path, r.oid, r.summary, r.at
    from unnest(${sql.param(exact)}::text[], ${sql.param(under)}::text[]) as e(path, under)
    cross join lateral (
      select oid, summary, at from page_revisions
      where page_id = ${pageId}
        and exists (select 1 from unnest(paths) as p where p = e.path or (e.under <> '' and p like e.under))
      order by seq desc
      limit 1
    ) r`);
  return new Map(
    rows.rows.map((row) => [
      row.path,
      { oid: Buffer.from(row.oid).toString('hex'), summary: row.summary, at: new Date(row.at) },
    ]),
  );
}

const README = /^readme\.md$/i;

/** The latest commit, how many there are, and folder `path` of the head with its README. */
export async function readRepoFolder(pageId: string, path: string, database: Database = getDb()): Promise<RepoFolder> {
  const dir = cleanRepoPath(path);
  if (dir === null) throw new ApiError(422, 'validation_error', 'not a path in the repository');
  const source = await repoSource(database, pageId);
  const [tree, latest] = await Promise.all([
    listTree(source.repo, source.root, dir),
    source.head ? historyWithHandles(pageId, { limit: 1, database }) : Promise.resolve([]),
  ]);
  if (!tree) throw new ApiError(404, 'not_found', 'no such folder in this page’s repository');

  const files = tree.filter((e) => !e.isTree);
  const sizes = await source.repo.sizes(files.map((e) => e.oid));
  // A PDF or picture is a Git LFS pointer in the tree: its size is what the pointer says.
  const pointers = files.filter((e) => lfsKindOf(joinPath(dir, e.name)));
  const pointed = pointers.length > 0 ? await source.repo.read(pointers.map((e) => e.oid)) : new Map();
  const last = source.head
    ? await lastCommits(
        database,
        pageId,
        tree.map((e) => ({ path: joinPath(dir, e.name), folder: e.isTree })),
      )
    : new Map();
  const entries: RepoEntry[] = tree
    .map((e): RepoEntry => {
      const entryPath = joinPath(dir, e.name);
      const pointer = pointed.get(e.oid) ? parseLfsPointer(pointed.get(e.oid)!.body.toString('utf8')) : null;
      return {
        name: e.name,
        path: entryPath,
        type: e.isTree ? 'folder' : 'file',
        bytes: e.isTree ? null : (pointer?.bytes ?? sizes.get(e.oid) ?? null),
        lfs: pointer !== null,
        last: last.get(entryPath) ?? null,
      };
    })
    // Folders first, then files, each by name as a reader sorts them.
    .sort((a, b) =>
      a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name, 'en', { numeric: true }),
    );

  const readmeEntry = files.find((e) => README.test(e.name));
  const readmeText = readmeEntry && (await readObject(source.repo, readmeEntry.oid))?.body.toString('utf8');
  const head = latest[0];
  return {
    placeholder: source.head === null,
    head: head
      ? {
          oid: head.oid,
          seq: head.seq,
          summary: head.summary,
          authorId: head.authorId,
          handle: head.handle,
          authorName: head.authorName,
          at: head.at,
        }
      : null,
    commits: head?.seq ?? 0,
    path: dir,
    entries,
    readme:
      readmeEntry && readmeText
        ? { path: joinPath(dir, readmeEntry.name), html: renderMarkdown(readmeText, 'readme') }
        : null,
  };
}

/** One file of the head, as the Repo tab shows it. */
export async function readRepoFile(pageId: string, path: string, database: Database = getDb()): Promise<RepoFile> {
  const clean = cleanRepoPath(path);
  if (!clean) throw new ApiError(422, 'validation_error', 'not a file path in the repository');
  const source = await repoSource(database, pageId);
  const slash = clean.lastIndexOf('/');
  const tree = await listTree(source.repo, source.root, slash < 0 ? '' : clean.slice(0, slash));
  const entry = tree?.find((e) => e.name === clean.slice(slash + 1) && !e.isTree);
  if (!entry) throw new ApiError(404, 'not_found', 'no such file in this page’s repository');
  const body = (await readObject(source.repo, entry.oid))!.body;
  return {
    placeholder: source.head === null,
    path: clean,
    oid: entry.oid,
    bytes: body.length,
    view: await viewOf(database, clean, body),
  };
}

async function viewOf(database: Database, path: string, body: Buffer): Promise<RepoFileView> {
  const lfs = lfsKindOf(path);
  const pointer = lfs ? parseLfsPointer(body.toString('utf8')) : null;
  if (lfs && pointer) {
    const stored = await findLfsObjects(database, [pointer.sha256]);
    return { type: 'lfs', kind: lfs, ...pointer, url: stored.get(pointer.sha256)?.url ?? null };
  }
  if (body.length > MAX_SHOWN_BYTES) return { type: 'large' };
  if (body.includes(0)) return { type: 'binary' };
  const text = body.toString('utf8');
  // A section shows as the page shows it (`sections.ts`), with its demos; any other Markdown as Markdown.
  for (const part of ALL_PARTS) {
    const name = sectionName(path, part);
    if (!name || text.trim() === '') continue;
    const demos = name.format === 'markdown' ? await previewDemoSources(text, database) : undefined;
    return { type: 'markdown', html: renderPart([{ path, name, text }], 'file', demos) ?? '' };
  }
  if (/\.md$/i.test(path) && text.trim() !== '') return { type: 'markdown', html: renderMarkdown(text, 'file') };
  return { type: 'text', text };
}
