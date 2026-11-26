import { createHash } from 'node:crypto';
import { getDb, type Database } from '@/db';
import { ApiError } from './api/errors';
import { storeLfsUpload } from './files';
import { findLfsObjects } from './lfs';
import { type Actor, commitPage, type CommitResult, type FileChange } from './pages/commit';
import { checkMayWrite, rolesOf } from './pages/check';
import { gitObject, parseMessage } from './pages/git-objects';
import { mergeWithMarkers } from './pages/merge';
import { findCommit, readCommit, readFiles, readHead, readObject, readText } from './pages/repo';
import { starterFilesOf } from './pages/starter';
import { mustPage } from './pages/kinds';
import { KINDS, type PageKind, partsOf } from '@/lib/kinds';
import { encodeLfsPointer, lfsKindOf, parseLfsPointer, pathDenied } from './pages/rules';

/**
 * A page repo as a web editor sees it: a working tree at the head, read a file at a time, and committed as a
 * set of changed files. This is the whole contract between the site and whichever editor it embeds
 * (`docs/web-editor.md`): nothing here knows about VS Code, so the editor can be replaced without touching it.
 * Every write still goes through `commitPage`, so the editor is held to the rules a push or a site edit is.
 */

/** Files are sent inline in the listing up to this many bytes in all; the rest are read with `readBlob`. */
const INLINE_BYTES = 2 * 1024 * 1024;

export interface WorkspaceFile {
  path: string;
  /** The blob's id, which `readBlob` reads; the same id is the same content. */
  oid: string;
  /** The file's text, when it came with the listing. */
  text?: string;
  /** For a Git LFS file (PDF or picture): the pointer's target, which the editor shows instead of the pointer. */
  lfs?: { sha256: string; bytes: number; url: string | null };
  /** Why this viewer can't change the file, or `null` if they can. */
  readonly: string | null;
}

/**
 * Where a viewer may add files on a page of this kind, by folder (or file, for the root's), each with a sample path to
 * ask the rules about, so the editor can say up front where they can't. The commit decides in the end.
 */
function areasOf(kind: PageKind): Record<string, string> {
  const areas: Record<string, string> = {};
  for (const part of partsOf(kind)) areas[`${part}/`] = `${part}/10-new.md`;
  if (kind === 'paper') {
    Object.assign(areas, {
      'versions/': 'versions/v_aaaaaaaa.json',
      'links/': 'links/10-new.json',
      'thumbnail.json': 'thumbnail.json',
      'demos/': 'demos/new/index.html',
    });
  }
  const { kindFile } = KINDS[kind];
  if (kindFile) areas[kindFile] = kindFile;
  areas['.potentialpaper/'] = '.potentialpaper/metadata.json';
  return areas;
}

export interface Workspace {
  /** The commit the files are at: send it back as the commit's base. `null` for a page with no history yet. */
  head: string | null;
  files: WorkspaceFile[];
  /** Signed in at all, so writes can be tried. */
  signedIn: boolean;
  areas: Record<string, string | null>;
}

const NOT_SIGNED_IN = 'sign in to edit';

export async function readWorkspace(
  pageId: string,
  actor: Actor | null,
  database: Database = getDb(),
): Promise<Workspace> {
  const { kind } = await mustPage(database, pageId);
  const roles = actor ? await rolesOf(database, actor, pageId) : null;
  const denied = (path: string) => (roles ? pathDenied(path, roles, kind) : NOT_SIGNED_IN);
  const head = await readHead(database, pageId);
  const tree = head ? await readFiles(database, pageId, (await readCommit(database, pageId, head)).tree) : new Map();

  const files: WorkspaceFile[] = [];
  const pointers = new Map<string, { sha256: string; bytes: number }>();
  let inline = 0;
  for (const [path, oid] of [...tree].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const file: WorkspaceFile = { path, oid, readonly: denied(path) };
    const body = inline < INLINE_BYTES || lfsKindOf(path) ? (await readObject(database, pageId, oid))?.body : null;
    if (body) {
      const text = body.toString('utf8');
      const pointer = lfsKindOf(path) ? parseLfsPointer(text) : null;
      if (pointer) {
        pointers.set(path, pointer);
      } else if (inline + body.length <= INLINE_BYTES) {
        file.text = text;
        inline += body.length;
      } else {
        inline = INLINE_BYTES;
      }
    }
    files.push(file);
  }
  // A page without a repo yet shows the files its first commit will start with (`starter.ts`), so the editor
  // opens on its empty sections; untouched, they are written by that commit as they are.
  if (!head) {
    for (const [path, text] of await starterFilesOf(database, pageId)) {
      files.push({ path, oid: gitObject('blob', Buffer.from(text)).oid, text, readonly: denied(path) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  }
  const stored = await findLfsObjects(
    database,
    [...pointers.values()].map((p) => p.sha256),
  );
  for (const file of files) {
    const pointer = pointers.get(file.path);
    if (pointer) file.lfs = { ...pointer, url: stored.get(pointer.sha256)?.url ?? null };
  }
  return {
    head,
    files,
    signedIn: actor !== null,
    areas: Object.fromEntries(Object.entries(areasOf(kind)).map(([area, sample]) => [area, denied(sample)])),
  };
}

/** One blob of the page's repo, by id: public, as a clone is, and never changing. */
export async function readBlob(pageId: string, oid: string, database: Database = getDb()): Promise<Buffer> {
  const found = /^[0-9a-f]{40}$/.test(oid) ? await readObject(database, pageId, oid) : null;
  if (found?.type !== 'blob') throw new ApiError(404, 'not_found', 'no such file in this page');
  return found.body;
}

export interface WorkspaceCommit {
  /** The `head` the editor loaded. Changes made since are merged in, as `commitPage` does. */
  baseOid: string | null;
  changes: FileChange[];
  /**
   * A commit message as git has one: a first line, which is the summary, and `Evidence: <url>` trailers in its
   * last paragraph, as a pushed commit carries them. Other trailers are refused, so nothing is silently dropped.
   */
  message: string;
}

export function readCommitMessage(message: string): { summary: string; evidence: string[] } {
  const { summary, trailers } = parseMessage(message);
  const evidence: string[] = [];
  for (const [key, value] of trailers) {
    if (key !== 'Evidence') {
      throw new ApiError(422, 'validation_error', `a commit takes Evidence: <url> trailers, not “${key}:”`);
    }
    evidence.push(value);
  }
  return { summary, evidence };
}

export async function commitWorkspace(
  pageId: string,
  actor: Actor,
  commit: WorkspaceCommit,
  database: Database = getDb(),
): Promise<CommitResult> {
  if (commit.baseOid && !(await findCommit(database, pageId, commit.baseOid))) {
    throw new ApiError(422, 'validation_error', 'the base is not a commit of this page');
  }
  const { summary, evidence } = readCommitMessage(commit.message);
  if (!summary) throw new ApiError(422, 'validation_error', 'say what the change is, in the first line');
  return commitPage(pageId, commit.baseOid, actor, commit.changes, summary, { evidence, database });
}

/**
 * Stores a PDF or a picture for a Git LFS path, as `git lfs` would upload it, and gives the pointer to write
 * at that path. Nothing is committed: the pointer is, with the editor's next commit.
 */
export async function storeWorkspaceFile(
  pageId: string,
  actor: Actor & { kind: 'account' },
  path: string,
  bytes: Buffer,
  database: Database = getDb(),
): Promise<{ pointer: string; sha256: string; bytes: number }> {
  if (!lfsKindOf(path)) {
    throw new ApiError(
      422,
      'validation_error',
      `${path} is not a PDF or picture path (thumbnail.png and the like, versions/<id>.pdf)`,
      { path },
    );
  }
  // Storing is slow and leaves a file behind, so only for someone the commit would take it from.
  await checkMayWrite(database, pageId, actor, [path]);
  await storeLfsUpload(actor.accountId, bytes, database);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { pointer: encodeLfsPointer({ sha256, bytes: bytes.length }), sha256, bytes: bytes.length };
}

export interface RebasedFile {
  path: string;
  /** The file at the head, which the editor now compares its change with. */
  original: string | null;
  /** The change made on top of the head: merged, with conflict markers where both changed the same lines. */
  content: string | null;
  conflict: boolean;
}

/**
 * Moves changes made from `baseOid` onto the head, as `git pull --rebase` would, without committing: for an
 * editor whose commit came back `409 edit_conflict`. Every file is merged, conflicts written between git's
 * markers for the person to settle, and the editor then commits from the new head.
 */
export async function rebaseWorkspace(
  pageId: string,
  baseOid: string | null,
  changes: readonly FileChange[],
  database: Database = getDb(),
): Promise<{ head: string | null; files: RebasedFile[] }> {
  const filesAt = async (oid: string | null) => {
    const commit = oid ? await findCommit(database, pageId, oid) : null;
    if (oid && !commit) throw new ApiError(422, 'validation_error', 'the base is not a commit of this page');
    return commit ? readFiles(database, pageId, commit.tree) : new Map<string, string>();
  };
  const head = await readHead(database, pageId);
  const [baseFiles, headFiles] = await Promise.all([filesAt(baseOid), filesAt(head)]);
  const files: RebasedFile[] = [];
  for (const { path, content } of changes) {
    const base = await readText(database, pageId, baseFiles.get(path));
    const theirs = await readText(database, pageId, headFiles.get(path));
    const merged = mergeWithMarkers(base, content, theirs, { ours: 'your change', theirs: 'the page now' });
    files.push({ path, original: theirs, content: merged.content, conflict: merged.conflict });
  }
  return { head, files };
}
