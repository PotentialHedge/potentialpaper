import { randomBytes } from 'node:crypto';
import { and, eq, max } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pgErrorCode } from '@/db/errors';
import {
  accounts,
  authorClaims,
  commitIdentities,
  pageEvents,
  pageObjects,
  pageRefs,
  pageRevisions,
  paperIdentifiers,
  papers,
} from '@/db/schema';
import { ApiError } from '../api/errors';
import { consume, rateLimitHeaders, type RateLimitConfig } from '../ratelimit';
import {
  buildTrees,
  type Commit,
  type EditKind,
  encodeCommit,
  gitObject,
  type GitObject,
  SYSTEM_AUTHOR_ID,
} from './git-objects';
import { mergeFile, type Version } from './merge';
import { lockPage, writeCurrent, writeRevision, type Writer } from './projections';
import { changedFiles, findCommit, readCommit, readFiles, readHead, readText, toBytes } from './repo';
import {
  cleanSummary,
  contentProblem,
  MAX_CHANGES,
  MAX_FILES,
  METADATA_PATH,
  normalizePath,
  pathDenied,
  type Roles,
} from './rules';

/**
 * The **only** writer of page state (DESIGN.md §4.4). One transaction covers the objects, the head, the
 * projections and the event, so they can never disagree.
 *
 * Still to come with the features that need them: page protection and tighter limits for new accounts
 * (Milestone 3), links (4), author identities and trailers (5). The routes that commit refresh the paper's
 * pages afterwards (`refresh.ts`), since this runs in scripts too (`info/refs` is never cached, and objects
 * never change).
 */

export type Actor = { kind: 'system' } | { kind: 'account'; accountId: string; isAdmin: boolean };

export const SYSTEM_ACTOR: Actor = { kind: 'system' };

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
  reverts?: string;
  database?: Database;
  rateLimit?: RateLimitConfig;
}

/** Enough for a burst of section edits, and well short of flooding a page's history. */
export const COMMIT_RATE_LIMIT: RateLimitConfig = { burst: 30, perSecond: 0.2 };

const IDENTITY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const IDENTITY_LENGTH = 8;

export function newIdentity(prefix: 'u' | 'a' = 'u'): string {
  return `${prefix}_${[...randomBytes(IDENTITY_LENGTH)].map((b) => IDENTITY_ALPHABET[b % IDENTITY_ALPHABET.length]).join('')}`;
}

/** The account's stable public id in commits, made on its first commit. */
async function commitIdentity(tx: Writer, accountId: string): Promise<string> {
  await tx.insert(commitIdentities).values({ id: newIdentity(), accountId }).onConflictDoNothing();
  const [row] = await tx
    .select({ id: commitIdentities.id })
    .from(commitIdentities)
    .where(eq(commitIdentities.accountId, accountId));
  // Only if the random id collided with another account's, which a retry won't repeat.
  if (!row) throw new ApiError(503, 'page_busy', 'could not make a commit identity; try again');
  return row.id;
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

function normalizeChanges(changes: readonly FileChange[]): FileChange[] {
  if (changes.length > MAX_CHANGES) {
    throw new ApiError(422, 'validation_error', `a commit can change at most ${MAX_CHANGES} files`);
  }
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

type ActorRoles = Roles & { bot: boolean; claimIdentity: string | null };

async function rolesOf(tx: Writer, actor: Actor, paperId: string): Promise<ActorRoles> {
  const confirmed = await tx
    .select({ accountId: authorClaims.accountId, identityId: authorClaims.identityId })
    .from(authorClaims)
    .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.status, 'confirmed')));
  const claimed = confirmed.length > 0;
  if (actor.kind === 'system') {
    return {
      system: true,
      admin: false,
      verified: false,
      confirmedAuthor: false,
      claimed,
      bot: false,
      claimIdentity: null,
    };
  }
  const claim = confirmed.find((c) => c.accountId === actor.accountId);
  const [account] = await tx
    .select({ isBot: accounts.isBot, verifiedAt: accounts.verifiedAt })
    .from(accounts)
    .where(eq(accounts.id, actor.accountId));
  if (!account) throw new ApiError(404, 'not_found', 'no such account');
  return {
    system: false,
    admin: actor.isAdmin,
    verified: account.isBot || account.verifiedAt !== null,
    confirmedAuthor: claim !== undefined,
    claimed,
    bot: account.isBot,
    // On their own paper an author is always named, never their handle (DESIGN.md §5.3).
    claimIdentity: claim?.identityId ?? null,
  };
}

function checkPermissions(changes: readonly FileChange[], roles: Roles): void {
  for (const { path } of changes) {
    const denied = pathDenied(path, roles);
    if (denied) throw new ApiError(403, 'forbidden', denied, { path });
  }
}

/** A file can't also be a directory, which only shows once the changes meet what's in the repo. */
function checkTreeShape(files: ReadonlyMap<string, unknown>): void {
  if (!files.has(METADATA_PATH)) {
    throw new ApiError(422, 'validation_error', 'a page keeps its metadata.json', { path: METADATA_PATH });
  }
  if (files.size > MAX_FILES) throw new ApiError(422, 'validation_error', `a page can have at most ${MAX_FILES} files`);
  for (const path of files.keys()) {
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
      if (files.has(path.slice(0, at))) {
        throw new ApiError(422, 'validation_error', 'a path is both a file and a directory', { path });
      }
    }
  }
}

function invalidContent(path: string, problem: string): ApiError {
  return new ApiError(422, 'validation_error', `${path} ${problem}`, { path });
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
  await tx
    .insert(pageObjects)
    .values(objects.map(({ oid, type, body }) => ({ paperId, oid: toBytes(oid), type, body })))
    .onConflictDoNothing();
}

/**
 * Commits changes that were made starting from `baseOid`, the commit the editor loaded, or `null` if the
 * page had no repo then. If the head has moved since, each changed file is merged with what happened in
 * between, and a real conflict throws `409 edit_conflict` with every version of each conflicting file.
 */
export async function commitPage(
  paperId: string,
  baseOid: string | null,
  actor: Actor,
  changes: readonly FileChange[],
  summary: string,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const { kind = 'edit', reverts, database = getDb(), rateLimit = COMMIT_RATE_LIMIT } = options;
  const wanted = normalizeChanges(changes);

  if (actor.kind === 'account') {
    const limit = await consume(`page-commit:${actor.accountId}`, rateLimit);
    if (!limit.allowed) {
      throw new ApiError(
        429,
        'rate_limited',
        'too many edits; wait a moment',
        { retryAfterSeconds: limit.retryAfterSeconds },
        rateLimitHeaders(limit),
      );
    }
  }

  try {
    return await database.transaction(async (tx) => {
      const roles = await rolesOf(tx, actor, paperId);
      checkPermissions(wanted, roles);

      const [paper] = await tx.select({ mergedInto: papers.mergedInto }).from(papers).where(eq(papers.id, paperId));
      if (!paper) throw new ApiError(404, 'not_found', 'no such paper');
      if (paper.mergedInto) {
        throw new ApiError(409, 'paper_merged', 'this paper was merged into another', { into: paper.mergedInto });
      }

      await lockPage(tx, paperId);
      const head = await readHead(tx, paperId);

      const baseCommit = baseOid ? await findCommit(tx, paperId, baseOid) : null;
      if (baseOid && !baseCommit) throw new ApiError(422, 'validation_error', 'the base is not a commit of this page');
      const baseFiles = baseCommit ? await readFiles(tx, paperId, baseCommit.tree) : new Map<string, string>();
      const headCommit = head ? await readCommit(tx, paperId, head) : null;
      const headFiles = headCommit ? await readFiles(tx, paperId, headCommit.tree) : new Map<string, string>();

      const blobs: GitObject[] = [];
      const files = new Map(headFiles);
      const conflicts: Conflict[] = [];
      for (const { path, content } of wanted) {
        const invalid = content === null ? null : contentProblem(path, content);
        if (invalid) throw invalidContent(path, invalid);

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
        if (merge.content !== content && contentProblem(path, merge.content)) {
          conflicts.push({ path, base, ours: content, theirs });
          continue;
        }
        const blob = gitObject('blob', Buffer.from(merge.content));
        blobs.push(blob);
        files.set(path, blob.oid);
      }
      if (conflicts.length > 0) {
        throw new ApiError(409, 'edit_conflict', 'someone else changed the same lines', { head, conflicts });
      }

      // Nothing to say is not a reason to start a repo, unless saying the metadata is the point.
      const isFirstCommit = head === null;
      const changedAny = changedFiles(headFiles, files).length > 0;
      if (!changedAny && !(isFirstCommit && actor.kind === 'system')) return { status: 'unchanged', oid: head };
      if (isFirstCommit && !files.has(METADATA_PATH)) {
        const metadata = gitObject('blob', Buffer.from(await metadataSnapshot(tx, paperId)));
        blobs.push(metadata);
        files.set(METADATA_PATH, metadata.oid);
      }
      checkTreeShape(files);

      const { root, trees } = buildTrees(files);

      const commit: Commit = {
        tree: root,
        parent: head,
        authorId:
          actor.kind === 'system'
            ? SYSTEM_AUTHOR_ID
            : (roles.claimIdentity ?? (await commitIdentity(tx, actor.accountId))),
        at: new Date(Math.floor(Date.now() / 1000) * 1000),
        summary: cleanSummary(summary),
        kind,
        reverts,
        bot: roles.bot,
      };
      const object = gitObject('commit', encodeCommit(commit));
      await writeObjects(tx, paperId, [...blobs, ...trees, object]);

      if (!(await moveHead(tx, paperId, head, object.oid))) {
        throw new ApiError(503, 'page_busy', 'the page changed during the edit; try again');
      }

      const [last] = await tx
        .select({ seq: max(pageRevisions.seq) })
        .from(pageRevisions)
        .where(eq(pageRevisions.paperId, paperId));
      const seq = (last?.seq ?? 0) + 1;
      const { paths, bytesDelta } = await writeRevision(tx, paperId, seq, object.oid, commit);
      await writeCurrent(tx, paperId, object.oid, commit);
      await tx.insert(pageEvents).values({
        paperId,
        seq,
        type: 'page.committed',
        payload: {
          oid: object.oid,
          parent: head,
          authorId: commit.authorId,
          kind,
          summary: commit.summary,
          paths,
          bytesDelta,
          ...(reverts ? { reverts } : {}),
          ...(roles.bot ? { bot: true } : {}),
        },
      });
      return { status: 'committed', oid: object.oid, seq, paths, merged: head !== baseOid };
    });
  } catch (err) {
    if (pgErrorCode(err) === '55P03') {
      throw new ApiError(503, 'page_busy', 'this page is being edited heavily; try again', undefined, {
        'Retry-After': '5',
      });
    }
    throw err;
  }
}

/**
 * Undoes one commit, keeping everything since: the files as they were before it, merged from it onto the
 * head, which is what `git revert` does. Goes through `commitPage`, so reverting needs the same permissions
 * as writing those paths. The first commit's metadata stays, because a page always has it.
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
  const changed = changedFiles(before, await readFiles(database, paperId, commit.tree)).filter(
    (file) => parent || file.path !== METADATA_PATH,
  );
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
