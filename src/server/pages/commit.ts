import { and, eq, max } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pgErrorCode } from '@/db/errors';
import { pageEvents, pageObjects, pageRefs, pageRevisions, papers, paperIdentifiers } from '@/db/schema';
import { ApiError } from '../api/errors';
import { copyDemos, type DemoPin, newDemoUrls, pinDemos, pinsFor } from '../demos/attach';
import type { RateLimitConfig } from '../ratelimit';
import {
  type Actor,
  authorIdOf,
  checkChangeCount,
  checkEvidence,
  checkPaper,
  checkPath,
  checkTree,
  fileProblem,
  rolesOf,
  takeCommit,
} from './check';
import { buildTrees, type Commit, type EditKind, encodeCommit, gitObject, type GitObject } from './git-objects';
import { mergeFile, type Version } from './merge';
import { lockPage, writeCurrent, writeRevision, type Writer } from './projections';
import { changedFiles, findCommit, readCommit, readFiles, readHead, readText, toBytes } from './repo';
import {
  cleanSummary,
  GITATTRIBUTES,
  GITATTRIBUTES_PATH,
  layoutProblem,
  METADATA_PATH,
  normalizePath,
  PREK_PATH,
} from './rules';
import { starterFiles } from './starter';

export { type Actor, COMMIT_RATE_LIMIT, newIdentity, SYSTEM_ACTOR } from './check';

/**
 * The **only** writer of page state (DESIGN.md §4.4). One transaction covers the objects, the head, the
 * projections and the event, so they can never disagree. What a commit may change is decided in `check.ts`,
 * for web edits here and for pushed commits in `receive.ts`; both store through `recordCommit`.
 *
 * Still to come with the features that need them: page protection and tighter limits for new accounts
 * (Milestone 3), links (4), author identities and trailers (5). The routes that commit refresh the paper's
 * pages afterwards (`refresh.ts`), since this runs in scripts too (`info/refs` is never cached, and objects
 * never change).
 */

export interface FileChange {
  path: string;
  /** The whole new file, or `null` to delete it. */
  content: string | null;
}

export interface Conflict {
  path: string;
  base: Version;
  ours: Version;
  theirs: Version;
}

export type CommitResult =
  | { status: 'committed'; oid: string; seq: number; paths: string[]; merged: boolean }
  /** Nothing would change, so nothing was written. `oid` is the head, if there is one. */
  | { status: 'unchanged'; oid: string | null };

export interface CommitOptions {
  kind?: EditKind;
  /** Addresses that back the change up: links, or files uploaded to `/api/v1/files` (`lib/evidence.ts`). */
  evidence?: readonly string[];
  reverts?: string;
  database?: Database;
  rateLimit?: RateLimitConfig;
  /** Commit even if no file changes, to record an event in the history, as a merge of a duplicate does. System only. */
  recordEmpty?: boolean;
  /**
   * Moving a page to a new layout (`layout-migration.ts`): the system may then write and delete any path,
   * however many, on a merged page too. What it writes is still checked. System only.
   */
  migration?: boolean;
}

/** The first commit's snapshot of the paper (DESIGN.md §4.2). Stable, so that it hashes the same when unchanged. */
async function metadataSnapshot(tx: Writer, paperId: string): Promise<string> {
  const [paper] = await tx.select().from(papers).where(eq(papers.id, paperId));
  const identifiers = await tx
    .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, paperId));
  identifiers.sort((a, b) => `${a.scheme}:${a.value}`.localeCompare(`${b.scheme}:${b.value}`, 'en'));
  const { title, authors, abstract, year, venue, source, metadataLicense, abstractLicense } = paper;
  const license = { metadata: metadataLicense, abstract: abstractLicense };
  return `${JSON.stringify({ identifiers, title, authors, abstract, year, venue, source, license }, null, 2)}\n`;
}

function normalizeChanges(changes: readonly FileChange[], migration: boolean): FileChange[] {
  if (!migration) checkChangeCount(changes.map(({ path }) => path));
  const seen = new Set<string>();
  return changes.map(({ path: raw, content }) => {
    const normal = normalizePath(raw);
    if ('problem' in normal) {
      throw new ApiError(422, 'validation_error', `the path ${normal.problem}`, { path: raw });
    }
    if (seen.has(normal.path)) {
      throw new ApiError(422, 'validation_error', 'the commit changes the same path twice', { path: normal.path });
    }
    seen.add(normal.path);
    return { path: normal.path, content };
  });
}

/**
 * Moves the head, only if it is still where the commit started. The page's lock already means it is, and
 * this is what stops a writer that got around the lock from losing someone's commit.
 */
export async function moveHead(tx: Writer, paperId: string, expected: string | null, next: string): Promise<boolean> {
  const moved = expected
    ? await tx
        .update(pageRefs)
        .set({ head: toBytes(next) })
        .where(and(eq(pageRefs.paperId, paperId), eq(pageRefs.head, toBytes(expected))))
        .returning({ paperId: pageRefs.paperId })
    : await tx
        .insert(pageRefs)
        .values({ paperId, head: toBytes(next) })
        .onConflictDoNothing()
        .returning({ paperId: pageRefs.paperId });
  return moved.length === 1;
}

async function writeObjects(tx: Writer, paperId: string, objects: readonly GitObject[]): Promise<void> {
  if (objects.length === 0) return;
  await tx
    .insert(pageObjects)
    .values(objects.map(({ oid, type, body }) => ({ paperId, oid: toBytes(oid), type, body })))
    .onConflictDoNothing();
}

/**
 * Stores a checked commit on top of the head, which has to be its parent: its objects, the head, the pins of
 * its new demos, its revision row and its event. The caller holds the page's lock, has run `checkTree`, and
 * writes `page_current` (`writeCurrent`) once its last commit is in. Shared by web edits and pushes, so both
 * leave the same rows behind.
 */
export async function recordCommit(
  tx: Writer,
  paperId: string,
  object: GitObject,
  commit: Commit,
  others: readonly GitObject[],
  pins: readonly DemoPin[],
): Promise<{ seq: number; paths: string[] }> {
  await writeObjects(tx, paperId, [...others, object]);
  if (!(await moveHead(tx, paperId, commit.parent, object.oid))) {
    throw new ApiError(503, 'page_busy', 'the page changed during the edit; try again');
  }
  await pinDemos(tx, paperId, object.oid, pins);

  const [last] = await tx
    .select({ seq: max(pageRevisions.seq) })
    .from(pageRevisions)
    .where(eq(pageRevisions.paperId, paperId));
  const seq = (last?.seq ?? 0) + 1;
  const { paths, bytesDelta } = await writeRevision(tx, paperId, seq, object.oid, commit);
  await tx.insert(pageEvents).values({
    paperId,
    seq,
    type: 'page.committed',
    payload: {
      oid: object.oid,
      parent: commit.parent,
      authorId: commit.authorId,
      kind: commit.kind,
      summary: commit.summary,
      paths,
      bytesDelta,
      ...(commit.reverts ? { reverts: commit.reverts } : {}),
      ...(commit.bot ? { bot: true } : {}),
      ...(commit.evidence ? { evidence: commit.evidence } : {}),
    },
  });
  return { seq, paths };
}

/** A lock that waited too long, said as what to do about it. */
export function busyError(err: unknown): unknown {
  return pgErrorCode(err) === '55P03'
    ? new ApiError(503, 'page_busy', 'this page is being edited heavily; try again', undefined, { 'Retry-After': '5' })
    : err;
}

/**
 * Commits changes that were made starting from `baseOid`, the commit the editor loaded, or `null` if the
 * page had no repo then. If the head has moved since, each changed file is merged with what happened in
 * between, and a real conflict throws `409 edit_conflict` with every version of each conflicting file.
 * Whatever the merge gives is then checked as a whole tree (`checkTree`).
 */
export async function commitPage(
  paperId: string,
  baseOid: string | null,
  actor: Actor,
  changes: readonly FileChange[],
  summary: string,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const { kind = 'edit', reverts, database = getDb(), rateLimit } = options;
  const migration = options.migration === true && actor.kind === 'system';
  const wanted = normalizeChanges(changes, migration);
  const evidence = checkEvidence(options.evidence ?? []);
  await takeCommit(actor, rateLimit);

  // Roles first and downloads last: what is refused for who is asking, or for what it says, never waits
  // for GitHub. The same checks run again under the lock, on the tree the merge makes.
  const early = await rolesOf(database, actor, paperId);
  await checkPaper(database, paperId, migration);
  for (const { path, content } of wanted) checkPath(path, content, early, migration);
  const snapshots = await copyDemos(database, await newDemoUrls(database, paperId, wanted));

  try {
    return await database.transaction(async (tx) => {
      const roles = await rolesOf(tx, actor, paperId);
      for (const { path, content } of wanted) checkPath(path, content === null ? null : undefined, roles, migration);
      await checkPaper(tx, paperId, migration);

      await lockPage(tx, paperId);
      const head = await readHead(tx, paperId);

      const baseCommit = baseOid ? await findCommit(tx, paperId, baseOid) : null;
      if (baseOid && !baseCommit) throw new ApiError(422, 'validation_error', 'the base is not a commit of this page');
      const baseFiles = baseCommit ? await readFiles(tx, paperId, baseCommit.tree) : new Map<string, string>();
      const headCommit = head ? await readCommit(tx, paperId, head) : null;
      const headFiles = headCommit ? await readFiles(tx, paperId, headCommit.tree) : new Map<string, string>();

      const blobs: GitObject[] = [];
      const files = new Map(headFiles);
      const written = new Map<string, string>();
      const conflicts: Conflict[] = [];
      for (const { path, content } of wanted) {
        const base = await readText(tx, paperId, baseFiles.get(path));
        const theirs = await readText(tx, paperId, headFiles.get(path));
        const merge = mergeFile(base, content, theirs);
        if (!merge.ok) {
          conflicts.push({ path, base, ours: content, theirs });
          continue;
        }
        if (merge.content === null) {
          files.delete(path);
          continue;
        }
        // Two valid edits can merge into something invalid, which is as much a conflict as any other.
        if (merge.content !== content && fileProblem(path, merge.content)) {
          conflicts.push({ path, base, ours: content, theirs });
          continue;
        }
        const blob = gitObject('blob', Buffer.from(merge.content));
        blobs.push(blob);
        files.set(path, blob.oid);
        written.set(blob.oid, merge.content);
      }
      if (conflicts.length > 0) {
        throw new ApiError(409, 'edit_conflict', 'someone else changed the same lines', { head, conflicts });
      }

      // Nothing to say is not a reason to start a repo, unless saying the metadata is the point.
      const isFirstCommit = head === null;
      const changedAny = changedFiles(headFiles, files).length > 0;
      const recordAnyway = (isFirstCommit || options.recordEmpty) && actor.kind === 'system';
      if (!changedAny && !recordAnyway) return { status: 'unchanged', oid: head };
      // The system starts every repo with the metadata, `.gitattributes` and the starter files (`starter.ts`),
      // whoever's edit starts it, so they are checked as there. An edit to a starter file replaces it.
      const before = new Map(headFiles);
      if (isFirstCommit) {
        const start: [string, () => Promise<string>][] = [
          [METADATA_PATH, () => metadataSnapshot(tx, paperId)],
          [GITATTRIBUTES_PATH, async () => GITATTRIBUTES],
          ...starterFiles()
            .filter(([path]) => !changes.some((change) => change.path === path))
            .map(([path, content]): [string, () => Promise<string>] => [path, async () => content]),
        ];
        for (const [path, make] of start) {
          if (files.has(path)) continue;
          const blob = gitObject('blob', Buffer.from(await make()));
          blobs.push(blob);
          files.set(path, blob.oid);
          before.set(path, blob.oid);
          written.set(blob.oid, blob.body.toString('utf8'));
        }
      }
      const added = await checkTree(tx, {
        paperId,
        roles,
        before,
        after: files,
        text: async (blob) => written.get(blob) ?? readText(tx, paperId, blob),
        newBlobBytes: new Map(blobs.map((blob) => [blob.oid, blob.body.length])),
        migration,
      });

      const { root, trees } = buildTrees(files);
      const commit: Commit = {
        tree: root,
        parent: head,
        authorId: await authorIdOf(tx, actor, roles),
        at: new Date(Math.floor(Date.now() / 1000) * 1000),
        summary: cleanSummary(summary),
        kind,
        reverts,
        bot: roles.bot,
        ...(evidence.length > 0 ? { evidence } : {}),
      };
      const object = gitObject('commit', encodeCommit(commit));
      const { seq, paths } = await recordCommit(
        tx,
        paperId,
        object,
        commit,
        [...blobs, ...trees],
        pinsFor(added, snapshots),
      );
      await writeCurrent(tx, paperId, object.oid, commit);
      return { status: 'committed', oid: object.oid, seq, paths, merged: head !== baseOid };
    });
  } catch (err) {
    throw busyError(err);
  }
}

/**
 * Undoes one commit, keeping everything since: the files as they were before it, merged from it onto the
 * head, which is what `git revert` does. Goes through `commitPage`, so reverting needs the same permissions
 * as writing those paths. The first commit's metadata and `.gitattributes` stay, because a page always has them.
 */
export async function revertCommit(
  paperId: string,
  target: string,
  actor: Actor,
  summary?: string,
  options: Omit<CommitOptions, 'kind' | 'reverts'> = {},
): Promise<CommitResult> {
  const database = options.database ?? getDb();
  const commit = await findCommit(database, paperId, target);
  if (!commit) throw new ApiError(404, 'not_found', 'no such commit on this page');

  const parent = commit.parent ? await readCommit(database, paperId, commit.parent) : null;
  const before = parent ? await readFiles(database, paperId, parent.tree) : new Map<string, string>();
  // The first commit's starter files are the system's, as its metadata is, unless the commit wrote in one.
  const started = new Map(starterFiles().map(([path, text]) => [path, gitObject('blob', Buffer.from(text)).oid]));
  const changed = changedFiles(before, await readFiles(database, paperId, commit.tree)).filter(
    (file) =>
      (parent || (file.path !== METADATA_PATH && started.get(file.path) !== file.after)) &&
      file.path !== GITATTRIBUTES_PATH &&
      file.path !== PREK_PATH,
  );
  // A commit from before the page's files were laid out as they are now (`layout-migration.ts`) would put
  // back files that have no place any more. Its text is still in the history and the diff, to copy from.
  const misplaced = changed.find((file) => layoutProblem(file.path));
  if (misplaced) {
    throw new ApiError(
      422,
      'validation_error',
      `this commit changed ${misplaced.path}, which pages no longer have since their files were laid out anew, so it can't be undone; edit the page instead`,
      { path: misplaced.path },
    );
  }
  const changes: FileChange[] = [];
  for (const file of changed) {
    changes.push({ path: file.path, content: await readText(database, paperId, file.before) });
  }
  return commitPage(paperId, target, actor, changes, summary ?? `Revert "${commit.summary}"`, {
    ...options,
    kind: 'revert',
    reverts: target,
  });
}
