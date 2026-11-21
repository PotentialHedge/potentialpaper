import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { accounts, authorClaims, botGrants, commitIdentities, pages, papers } from '@/db/schema';
import { isUnderDomain, KINDS, orgFileSchema, type PageKind, partsOf } from '@/lib/kinds';
import { parseReviewPath, SUBMISSION_FILE } from '@/lib/review-files';
import { cleanEvidence } from '@/lib/evidence';
import { MAX_LINKS, parseLinkFile } from '@/lib/paper-links';
import { MAX_VERSIONS, parseVersionFile } from '@/lib/versions';
import { ApiError } from '../api/errors';
import { checkDemos } from '../demos/attach';
import { findLfsObjects, PDF_TYPE } from '../lfs';
import { consume, rateLimitHeaders, type RateLimitConfig } from '../ratelimit';
import { SYSTEM_AUTHOR_ID, type FileTree } from './git-objects';
import type { Writer } from './projections';
import { mustPage, type PageRow } from './kinds';
import { changedFiles, type Reader } from './repo';
import {
  contentProblem,
  grantCovers,
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
  parseLfsPointer,
  pathDenied,
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
import { pageClaimRoles } from '../page-claims';
import { domainsAbove, isOrgMember } from '../org-roles';
import { checkProtection, isEstablished } from '../page-protection';

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

/**
 * `established`: verified long enough ago that a page under `established` protection lets them edit
 * (`page-protection.ts`).
 */
export type ActorRoles = Roles & { bot: boolean; claimIdentity: string | null; kind: PageKind; established: boolean };

/**
 * Whether an account owns the page, by its kind's claim policy (`KINDS[kind].owners.claim`), and whether anyone does:
 * a paper's confirmed authors (with the claim's `a_…` identity they sign with), a venue's confirmed organisers here or
 * on the series above it (`page-claims.ts`), an org's verified members by address (`org-roles.ts`), a person's page's
 * account. `account` is `null` for the system. A bot owns nothing.
 */
async function ownership(
  db: Reader,
  page: PageRow,
  account: { id: string; isBot: boolean; verified: boolean; handle: string | null } | null,
): Promise<{ owner: boolean; claimed: boolean; claimIdentity: string | null }> {
  const person = account && !account.isBot ? account : null;
  // A person's page is its account's (a plugin's `viewer.isOwner`), though it has no files to write.
  if (page.kind === 'user')
    return { owner: person !== null && person.handle === page.key, claimed: false, claimIdentity: null };
  switch (KINDS[page.kind].owners?.claim) {
    case 'authors': {
      const confirmed = await db
        .select({ accountId: authorClaims.accountId, identityId: authorClaims.identityId })
        .from(authorClaims)
        .where(and(eq(authorClaims.paperId, page.id), eq(authorClaims.status, 'confirmed')));
      const claim = person ? confirmed.find((c) => c.accountId === person.id) : undefined;
      // On their own paper an author is always named, never their handle (DESIGN.md §5.3).
      return { owner: claim !== undefined, claimed: confirmed.length > 0, claimIdentity: claim?.identityId ?? null };
    }
    case 'organisers':
      return { ...(await pageClaimRoles(db, page, person?.id ?? null)), claimIdentity: null };
    case 'domain':
      return {
        owner: person !== null && person.verified && (await isOrgMember(db, page, person.id)),
        claimed: false,
        claimIdentity: null,
      };
    default:
      return { owner: false, claimed: false, claimIdentity: null };
  }
}

/** Who the actor is on the page: its roles under the path rules of its kind (`rules.ts`), the same way on every kind. */
export async function rolesOf(db: Reader, actor: Actor, pageId: string): Promise<ActorRoles> {
  const page = await mustPage(db, pageId);
  if (actor.kind === 'system') {
    const { claimed } = await ownership(db, page, null);
    return {
      system: true,
      admin: false,
      verified: false,
      owner: false,
      claimed,
      bot: false,
      claimIdentity: null,
      kind: page.kind,
      established: false,
    };
  }
  const [account] = await db
    .select({ isBot: accounts.isBot, verifiedAt: accounts.verifiedAt, handle: accounts.handle })
    .from(accounts)
    .where(eq(accounts.id, actor.accountId));
  if (!account) throw new ApiError(404, 'not_found', 'no such account');
  // A bot's grants are rows (DESIGN.md §10), checked by the same path rules as everyone's roles.
  const grants = account.isBot
    ? (
        await db
          .select({ pattern: botGrants.pattern })
          .from(botGrants)
          .where(and(eq(botGrants.accountId, actor.accountId), eq(botGrants.kind, page.kind)))
      ).map((row) => row.pattern)
    : [];
  const verified = account.isBot || account.verifiedAt !== null;
  const owns = await ownership(db, page, {
    id: actor.accountId,
    isBot: account.isBot,
    verified: account.verifiedAt !== null,
    handle: account.handle,
  });
  return {
    system: false,
    admin: actor.isAdmin,
    verified,
    established: isEstablished(account.verifiedAt),
    owner: owns.owner,
    claimed: owns.claimed,
    bot: account.isBot,
    grants,
    claimIdentity: owns.claimIdentity,
    kind: page.kind,
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

/**
 * The page is there and not merged into another, whose page is the one to edit: a paper (`papers.merged_into`) or a
 * topic (`pages.merged_into`, `topic-pages.ts`).
 */
export async function checkPaper(db: Reader, pageId: string, migration = false): Promise<void> {
  const page = await mustPage(db, pageId);
  if (page.kind !== 'paper') {
    const [row] = await db.select({ mergedInto: pages.mergedInto }).from(pages).where(eq(pages.id, pageId));
    if (row?.mergedInto && !migration) {
      throw new ApiError(409, 'page_merged', 'this page was merged into another', { into: row.mergedInto });
    }
    return;
  }
  const [paper] = await db.select({ mergedInto: papers.mergedInto }).from(papers).where(eq(papers.id, pageId));
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
export function checkPath(
  path: string,
  content: string | null | undefined,
  roles: Roles & { kind?: PageKind },
  migration: boolean,
): void {
  const kind = roles.kind ?? 'paper';
  const denied = migration ? null : pathDenied(path, roles, kind);
  if (denied) throw new ApiError(403, 'forbidden', denied, { path });
  if (content === null) return;
  // A file that has no place in the layout can still be deleted, so that such a page can be cleaned up.
  const misplaced = layoutProblem(path, kind);
  if (misplaced) throw new ApiError(422, 'validation_error', `${path}: ${misplaced}`, { path });
  if (content === undefined) return;
  const invalid = fileProblem(path, content, kind);
  if (invalid) throw invalidContent(path, invalid);
}

/** Refuses up front what a commit of these paths would be refused for who is asking, before slow work such as storing an upload. */
export async function checkMayWrite(db: Reader, pageId: string, actor: Actor, paths: readonly string[]): Promise<void> {
  const roles = await rolesOf(db, actor, pageId);
  await checkPaper(db, pageId);
  for (const path of paths) checkPath(path, undefined, roles, false);
  await checkProtection(db, pageId, roles, paths);
}

/** Why this can't be the file's content, or `null`: `contentProblem`, and the page's fixed `prek.toml`. */
export function fileProblem(path: string, content: string, kind: PageKind = 'paper'): string | null {
  return path === PREK_PATH ? prekProblem(content) : contentProblem(path, content, kind);
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
function checkTreeShape(files: FileTree, kind: PageKind): void {
  if (!files.has(METADATA_PATH)) {
    throw new ApiError(422, 'validation_error', `a page keeps its ${METADATA_PATH}`, { path: METADATA_PATH });
  }
  const paths = [...files.keys()];
  checkPathsShape(files, paths, kind);
  if (kind !== 'paper') return;
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
}

/** What every kind's tree keeps to: its files' count, sections per part, and no path both a file and a folder. */
function checkPathsShape(files: FileTree, paths: readonly string[], kind: PageKind): void {
  if (kind !== 'paper' && files.size > MAX_FILES) {
    throw new ApiError(422, 'validation_error', `a page can have at most ${MAX_FILES} files`);
  }
  for (const part of partsOf(kind)) {
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

async function orgDomains(files: FileTree, text: TextOf): Promise<string[]> {
  const blob = files.get(KINDS.org.kindFile);
  if (!blob) return [];
  try {
    const parsed = orgFileSchema.safeParse(JSON.parse((await text(blob)) ?? 'null'));
    return parsed.success ? (parsed.data.domains ?? []) : [];
  } catch {
    return [];
  }
}

/**
 * An org's `domains` say who its members are and which papers are its own, so they are not anyone's to widen
 * (`handoffs/pages.md` Phase 4). A top-level org's come from the institution allowlist: only admins and the `orgs`
 * bot change them. A department's or lab's are its organisation's or under them (`inf.ethz.ch` under `ethz.ch`), so
 * its members can't take in another institution's people or papers.
 */
async function checkOrgDomains(db: Reader, check: TreeCheck): Promise<void> {
  const { roles } = check;
  if (roles.system || roles.admin) return;
  const path = KINDS.org.kindFile;
  const page = await mustPage(db, check.pageId);
  const after = await orgDomains(check.after, check.text);
  if (!page.key.includes('/')) {
    const granted = roles.grants?.some((pattern) => grantCovers(pattern, path)) ?? false;
    if (granted) return;
    const before = await orgDomains(check.before, check.text);
    const same = before.length === after.length && before.every((domain) => after.includes(domain));
    if (!same) {
      throw new ApiError(
        403,
        'forbidden',
        `${path}: only admins and the orgs bot change a top-level organisation's domains`,
        { path },
      );
    }
    return;
  }
  const above = await domainsAbove(db, page);
  for (const domain of after) {
    if (!above.some((under) => isUnderDomain(domain, under))) {
      throw new ApiError(
        422,
        'validation_error',
        above.length > 0
          ? `${path}: ${domain} is not one of its organisation's domains or under one (${above.join(', ')})`
          : `${path}: ${domain}: its organisation has no domains for a department's to be under`,
        { path },
      );
    }
  }
}

/** Each version's submission that names imported reviews, by its `reviews`, as text that ignores key order. */
async function importedSubmissions(
  files: FileTree,
  text: TextOf,
): Promise<Map<string, { entry: string; path: string }>> {
  const entries = new Map<string, { entry: string; path: string }>();
  for (const [path, blob] of files) {
    const id = versionIdOf(path);
    if (!id) continue;
    const parsed = parseVersionFile(id, (await text(blob)) ?? '');
    if (!('version' in parsed)) continue;
    for (const entry of parsed.version.submissions ?? []) {
      if (!entry.reviews) continue;
      const sorted = Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1)));
      entries.set(entry.reviews, { entry: JSON.stringify(sorted), path });
    }
  }
  return entries;
}

/**
 * A version's submission whose `reviews` names a bot's folder says what the venue decided, as that bot imported it:
 * only the bot granted the folder's source and admins add, change or remove one (DESIGN.md §3). Moving it to
 * another version unchanged is anyone's to do, as is everything else in the version.
 */
async function checkImportedSubmissions(check: TreeCheck): Promise<void> {
  const { roles } = check;
  if (roles.system || roles.admin) return;
  const before = await importedSubmissions(check.before, check.text);
  const after = await importedSubmissions(check.after, check.text);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key);
    const now = after.get(key);
    if (was?.entry === now?.entry) continue;
    const folder = `reviews/${key}/`;
    if (roles.grants?.some((pattern) => grantCovers(pattern, `${folder}${SUBMISSION_FILE}`))) continue;
    throw new ApiError(
      403,
      'forbidden',
      `the submission with reviews ${key} is what the venue decided, as its bot imported it: only the bot granted ${folder.replace(/[^/]+\/$/, '')} and admins change it`,
      { path: (now ?? was)!.path },
    );
  }
}

export interface TreeCheck {
  pageId: string;
  /** The roles of whoever commits, on this page; `kind` is the page's (a paper's when absent). */
  roles: Roles & { kind?: PageKind; established?: boolean };
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
  // A protected page holds back the community's paths from those below its level (`page-protection.ts`).
  if (!migration) await checkProtection(db, check.pageId, roles, changed);
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
    const invalid = fileProblem(path, content, roles.kind);
    if (invalid) throw invalidContent(path, invalid);
  }

  const kind = roles.kind ?? 'paper';
  checkTreeShape(after, kind);
  if (kind === 'org' && changed.includes(KINDS.org.kindFile)) {
    await checkOrgDomains(db, check);
  }
  // Pages of other kinds have no title links, PDFs, pictures or demos (`lib/kinds.ts`'s file types).
  if (kind !== 'paper') return [];
  if (changed.some(isLinkPath)) await checkLinkLabels(after, text);
  if (changed.some((path) => versionIdOf(path))) await checkImportedSubmissions(check);
  await checkLfsFiles(changed, after, text, db);
  return checkDemos(db, {
    pageId: check.pageId,
    roles,
    changed,
    headFiles: before,
    files: after,
    text,
    newBlobBytes: check.newBlobBytes,
    migration,
  });
}
