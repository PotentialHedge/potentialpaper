import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { accounts, authorClaims, botGrants, commitIdentities, papers } from '@/db/schema';
import { parseReviewPath, SUBMISSION_FILE } from '@/lib/review-files';
import { cleanEvidence } from '@/lib/evidence';
import { MAX_LINKS, parseLinkFile } from '@/lib/paper-links';
import { MAX_VERSIONS } from '@/lib/versions';
import { ApiError } from '../api/errors';
import { checkDemos } from '../demos/attach';
import { findLfsObjects, PDF_TYPE } from '../lfs';
import { consume, rateLimitHeaders, type RateLimitConfig } from '../ratelimit';
import { SYSTEM_AUTHOR_ID, type FileTree } from './git-objects';
import type { Writer } from './projections';
import { changedFiles, type Reader } from './repo';
import {
  contentProblem,
  isDemoPath,
  isLinkPath,
  isReviewPath,
  layoutProblem,
  LFS_NEEDED,
  lfsKindOf,
  MAX_CHANGES,
  MAX_DEMOS_FILES,
  MAX_FILES,
  MAX_REVIEW_CHANGES,
  MAX_REVIEW_FILES,
  MAX_SECTIONS,
  METADATA_PATH,
  normalizePath,
  PAGE_PARTS,
  PAPER_PDF_PATH,
  parseLfsPointer,
  pathDenied,
  PDF_PATH,
  PREK_PATH,
  type Roles,
  sectionName,
  THUMBNAIL_PATH,
  THUMBNAIL_TYPES,
  thumbnailImagePath,
  thumbnailImageType,
  versionIdOf,
  versionPath,
  versionPdfIdOf,
} from './rules';
import { prekProblem } from './starter';

/**
 * Whether a change to a page's tree is allowed: who is making it, what it writes, and what the whole tree
 * then holds. **Every** way of committing comes through `checkTree`: a web edit, which builds its tree from
 * file changes (`commit.ts`), and a push, whose trees arrive as git made them (`receive.ts`). So a rule
 * belongs here, not in an API route, whenever a tree written by hand could break it. Routes keep only what
 * is about the request: parsing it, and conveniences such as merging a section against the commit the
 * editor loaded.
 *
 * Order matters for what costs: the actor's roles first, then the paths, the files and the tree, all read
 * from Postgres; the downloads of demos from GitHub come last, after every check that can refuse without
 * them (`commit.ts`, `receive.ts`).
 */

export type Actor = { kind: 'system' } | { kind: 'account'; accountId: string; isAdmin: boolean };

export const SYSTEM_ACTOR: Actor = { kind: 'system' };

export type ActorRoles = Roles & { bot: boolean; claimIdentity: string | null };

export async function rolesOf(db: Reader, actor: Actor, paperId: string): Promise<ActorRoles> {
  const confirmed = await db
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
  const [account] = await db
    .select({ isBot: accounts.isBot, verifiedAt: accounts.verifiedAt })
    .from(accounts)
    .where(eq(accounts.id, actor.accountId));
  if (!account) throw new ApiError(404, 'not_found', 'no such account');
  // A bot's grants are rows (DESIGN.md §10), checked by the same path rules as everyone's roles.
  const grants = account.isBot
    ? (
        await db.select({ pattern: botGrants.pattern }).from(botGrants).where(eq(botGrants.accountId, actor.accountId))
      ).map((row) => row.pattern)
    : [];
  return {
    system: false,
    admin: actor.isAdmin,
    verified: account.isBot || account.verifiedAt !== null,
    confirmedAuthor: claim !== undefined,
    claimed,
    bot: account.isBot,
    grants,
    // On their own paper an author is always named, never their handle (DESIGN.md §5.3).
    claimIdentity: claim?.identityId ?? null,
  };
}

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

/**
 * The id the actor's commits to this page are signed with: the system's, the per-claim `a_…` on a paper
 * they are a confirmed author of, and otherwise their `u_…` (DESIGN.md §4.4). A pushed commit has to be
 * signed with exactly this, as author and committer (`receive.ts`).
 */
export async function authorIdOf(tx: Writer, actor: Actor, roles: ActorRoles): Promise<string> {
  if (actor.kind === 'system') return SYSTEM_AUTHOR_ID;
  return roles.claimIdentity ?? commitIdentity(tx, actor.accountId);
}

/** Enough for a burst of section edits, and well short of flooding a page's history. */
export const COMMIT_RATE_LIMIT: RateLimitConfig = { burst: 30, perSecond: 0.2 };

/** Takes one commit from the account's bucket, or refuses. A push takes one for each of its commits. */
export async function takeCommit(actor: Actor, rateLimit: RateLimitConfig = COMMIT_RATE_LIMIT): Promise<void> {
  if (actor.kind !== 'account') return;
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

/** The paper is there, and is not merged into another (whose page is the one to edit). */
export async function checkPaper(db: Reader, paperId: string, migration = false): Promise<void> {
  const [paper] = await db.select({ mergedInto: papers.mergedInto }).from(papers).where(eq(papers.id, paperId));
  if (!paper) throw new ApiError(404, 'not_found', 'no such paper');
  if (paper.mergedInto && !migration) {
    throw new ApiError(409, 'paper_merged', 'this paper was merged into another', { into: paper.mergedInto });
  }
}

/** The evidence, cleaned (`lib/evidence.ts`), or a refusal. */
export function checkEvidence(urls: readonly string[]): string[] {
  const cleaned = cleanEvidence(urls);
  if ('problem' in cleaned) throw new ApiError(422, 'validation_error', cleaned.problem);
  return cleaned.evidence;
}

/**
 * The rules one path decides: who may write or delete it, whether it has a place in the layout, and,
 * when its content is known, whether that content is valid. Cheap, so `commitPage` runs it on the changes
 * it is asked for before anything else, and `checkTree` on every path a tree changes.
 */
export function checkPath(path: string, content: string | null | undefined, roles: Roles, migration: boolean): void {
  const denied = migration ? null : pathDenied(path, roles);
  if (denied) throw new ApiError(403, 'forbidden', denied, { path });
  if (content === null) return;
  // A file that has no place in the layout can still be deleted, so that such a page can be cleaned up.
  const misplaced = layoutProblem(path);
  if (misplaced) throw new ApiError(422, 'validation_error', `${path}: ${misplaced}`, { path });
  if (content === undefined) return;
  const invalid = fileProblem(path, content);
  if (invalid) throw invalidContent(path, invalid);
}

/** Refuses up front what a commit of these paths would be refused for who is asking, before slow work such as storing an upload. */
export async function checkMayWrite(
  db: Reader,
  paperId: string,
  actor: Actor,
  paths: readonly string[],
): Promise<void> {
  const roles = await rolesOf(db, actor, paperId);
  await checkPaper(db, paperId);
  for (const path of paths) checkPath(path, undefined, roles, false);
}

/** Why this can't be the file's content, or `null`: `contentProblem`, and the page's fixed `prek.toml`. */
export function fileProblem(path: string, content: string): string | null {
  return path === PREK_PATH ? prekProblem(content) : contentProblem(path, content);
}

export function invalidContent(path: string, problem: string): ApiError {
  return new ApiError(422, 'validation_error', `${path} ${problem}`, { path });
}

/**
 * At most `MAX_CHANGES` files a commit, besides up to `MAX_DEMOS_FILES` of demos, which go in together, and
 * `MAX_REVIEW_CHANGES` of a bot's imported reviews.
 */
export function checkChangeCount(paths: readonly string[]): void {
  const demoFiles = paths.filter(isDemoPath).length;
  const reviewFiles = paths.filter(isReviewPath).length;
  if (paths.length - demoFiles - reviewFiles > MAX_CHANGES) {
    throw new ApiError(422, 'validation_error', `a commit can change at most ${MAX_CHANGES} files`);
  }
  if (reviewFiles > MAX_REVIEW_CHANGES) {
    throw new ApiError(422, 'validation_error', `a commit can change at most ${MAX_REVIEW_CHANGES} review files`);
  }
  if (demoFiles > MAX_DEMOS_FILES) {
    throw new ApiError(422, 'validation_error', `a commit can change at most ${MAX_DEMOS_FILES} demo files`);
  }
}

/**
 * What only shows once the changes meet what's in the repo: a file can't also be a directory, and the
 * directories of links, versions and sections have their limits.
 */
function checkTreeShape(files: FileTree): void {
  if (!files.has(METADATA_PATH)) {
    throw new ApiError(422, 'validation_error', `a page keeps its ${METADATA_PATH}`, { path: METADATA_PATH });
  }
  const paths = [...files.keys()];
  const reviewFiles = paths.filter(isReviewPath);
  if (files.size - reviewFiles.length > MAX_FILES) {
    throw new ApiError(422, 'validation_error', `a page can have at most ${MAX_FILES} files`);
  }
  if (reviewFiles.length > MAX_REVIEW_FILES) {
    throw new ApiError(422, 'validation_error', `a page can have at most ${MAX_REVIEW_FILES} review files`);
  }
  // A submission's forms and notes are read with it, so its folder has its submission.json.
  for (const path of reviewFiles) {
    const review = parseReviewPath(path);
    if (!review || review.kind === 'submission') continue;
    const submission = `reviews/${review.source}/${review.submission}/${SUBMISSION_FILE}`;
    if (!files.has(submission)) {
      throw new ApiError(422, 'validation_error', `${path} belongs to a submission, so it needs ${submission}`, {
        path,
      });
    }
  }
  if (paths.filter(isLinkPath).length > MAX_LINKS) {
    throw new ApiError(422, 'validation_error', `a page can have at most ${MAX_LINKS} links`);
  }
  if (paths.filter((path) => versionIdOf(path)).length > MAX_VERSIONS) {
    throw new ApiError(422, 'validation_error', `a page can have at most ${MAX_VERSIONS} versions`);
  }
  const pictures = paths.filter((path) => thumbnailImageType(path));
  if (pictures.length > 1) {
    throw new ApiError(422, 'validation_error', `a page has one picture, not ${pictures.join(' and ')}`, {
      path: pictures[1],
    });
  }
  if (files.has(THUMBNAIL_PATH) && pictures.length === 0) {
    throw new ApiError(
      422,
      'validation_error',
      `${THUMBNAIL_PATH} has the words for the picture: add the picture beside it (thumbnail.png, .jpg, .gif, .webp or .avif), or remove it too`,
      { path: THUMBNAIL_PATH },
    );
  }
  for (const path of paths) {
    const id = versionPdfIdOf(path);
    if (id && !files.has(versionPath(id))) {
      throw new ApiError(422, 'validation_error', `${path} is the PDF of a version, so it needs ${versionPath(id)}`, {
        path,
      });
    }
  }
  if (files.has(PAPER_PDF_PATH) !== files.has(PDF_PATH)) {
    throw new ApiError(422, 'validation_error', `${PAPER_PDF_PATH} and ${PDF_PATH} go together`, { path: PDF_PATH });
  }
  for (const part of PAGE_PARTS) {
    if (paths.filter((path) => sectionName(path, part)).length > MAX_SECTIONS) {
      throw new ApiError(422, 'validation_error', `a part can have at most ${MAX_SECTIONS} sections`);
    }
  }
  for (const path of files.keys()) {
    for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
      if (files.has(path.slice(0, at))) {
        throw new ApiError(422, 'validation_error', 'a path is both a file and a directory', { path });
      }
    }
  }
}

type TextOf = (blob: string) => Promise<string | null>;

/** Two links can't have one label, as a link with a built-in link's label replaces it (`lib/paper-links.ts`). */
async function checkLinkLabels(files: FileTree, text: TextOf): Promise<void> {
  const labels = new Set<string>();
  for (const [path, blob] of files) {
    if (!isLinkPath(path)) continue;
    const label = parseLinkFile((await text(blob)) ?? '')?.label.toLowerCase();
    if (label === undefined) continue;
    if (labels.has(label)) throw new ApiError(422, 'validation_error', `two links are called “${label}”`, { path });
    labels.add(label);
  }
}

/**
 * A PDF or the picture is a Git LFS pointer to bytes this site stored (`server/lfs.ts`): it read them first and
 * knows what they are, so a page never links to a PDF that isn't one, or shows a picture from anywhere.
 * `git lfs` uploads the bytes before it pushes (`server/git/lfs.ts`); the web editors store them first.
 */
async function checkLfsFiles(changed: readonly string[], after: FileTree, text: TextOf, db: Reader) {
  const pointers = new Map<string, { sha256: string; bytes: number }>();
  for (const path of changed) {
    const blob = after.get(path);
    if (!blob || !lfsKindOf(path)) continue;
    const pointer = parseLfsPointer((await text(blob)) ?? '');
    if (pointer) pointers.set(path, pointer);
  }
  if (pointers.size === 0) return;
  const known = await findLfsObjects(
    db,
    [...pointers.values()].map((p) => p.sha256),
  );
  for (const [path, pointer] of pointers) {
    const object = known.get(pointer.sha256);
    if (!object) {
      throw new ApiError(
        422,
        'validation_error',
        `${path}: the file with sha256 ${pointer.sha256} isn't stored here; push with Git LFS installed, which uploads it first`,
        { path },
      );
    }
    if (object.bytes !== pointer.bytes) {
      throw new ApiError(
        422,
        'validation_error',
        `${path}: that file has ${object.bytes} bytes, not ${pointer.bytes}`,
        {
          path,
        },
      );
    }
    if (lfsKindOf(path) === 'pdf' && object.type !== PDF_TYPE) {
      throw new ApiError(422, 'validation_error', `${path} is not a PDF`, { path });
    }
    const named = thumbnailImageType(path);
    if (named && object.type !== named) {
      const type = THUMBNAIL_TYPES.find((t) => t === object.type);
      throw new ApiError(
        422,
        'validation_error',
        type ? `${path} is a ${type}, so call it ${thumbnailImagePath(type)}` : `${path} is not a picture`,
        { path },
      );
    }
  }
}

export interface TreeCheck {
  paperId: string;
  roles: Roles;
  /** The parent's files, or none for a page's first commit. */
  before: FileTree;
  /** The files the commit will have. */
  after: FileTree;
  /** A blob's text, whether it is new in this commit or already stored; `null` if it isn't UTF-8 text. */
  text: TextOf;
  /** The size of each blob that may not be stored yet. */
  newBlobBytes: ReadonlyMap<string, number>;
  /** A system migration (`layout-migration.ts`), which may write and delete any path, however many. */
  migration?: boolean;
}

/**
 * Whether going from `before` to `after` is allowed for these roles. Refuses with an `ApiError` that says
 * what to change, naming the path. Returns the GitHub addresses of demos new to the page, which have to be
 * copied before the commit is stored (`copyDemos`, `pinsFor`).
 *
 * Checks, in order: the number of changed files; for each changed path, its normal form (NFC, safe on every
 * filesystem), who may change it, its place in the layout and its content (JSON shapes, the HTML allowlist,
 * Git LFS pointers); then across the tree: its limits, link labels, that each pointer's bytes are stored
 * here, and the demos.
 */
export async function checkTree(db: Reader, check: TreeCheck): Promise<string[]> {
  const { before, after, text, roles } = check;
  const migration = check.migration === true && roles.system;
  const changed = changedFiles(before, after).map((file) => file.path);
  if (!migration) checkChangeCount(changed);

  // Who may change each path, before anything is read.
  for (const path of changed) {
    const normal = normalizePath(path);
    if ('problem' in normal) throw new ApiError(422, 'validation_error', `the path ${normal.problem}`, { path });
    if (normal.path !== path) {
      throw new ApiError(422, 'validation_error', 'the path is not in Unicode normal form (NFC)', { path });
    }
    checkPath(path, after.has(path) ? undefined : null, roles, migration);
  }
  for (const path of changed) {
    const blob = after.get(path);
    if (blob === undefined) continue;
    const content = await text(blob);
    if (content === null) {
      throw invalidContent(
        path,
        lfsKindOf(path)
          ? LFS_NEEDED
          : isDemoPath(path)
            ? "is not UTF-8 text; a demo's binary files (pictures, models, wasm) come from GitHub"
            : 'is not UTF-8 text',
      );
    }
    const invalid = fileProblem(path, content);
    if (invalid) throw invalidContent(path, invalid);
  }

  checkTreeShape(after);
  if (changed.some(isLinkPath)) await checkLinkLabels(after, text);
  await checkLfsFiles(changed, after, text, db);
  return checkDemos(db, {
    paperId: check.paperId,
    roles,
    changed,
    headFiles: before,
    files: after,
    text,
    newBlobBytes: check.newBlobBytes,
    migration,
  });
}
