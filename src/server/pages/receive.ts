import { getDb, type Database } from '@/db';
import { ApiError, type ApiErrorCode } from '../api/errors';
import { copyDemos, pinsFor } from '../demos/attach';
import type { RateLimitConfig } from '../ratelimit';
import {
  type Actor,
  type ActorRoles,
  authorIdOf,
  checkEvidence,
  checkPaper,
  checkTree,
  rolesOf,
  takeCommit,
} from './check';
import { busyError, recordCommit } from './commit';
import {
  buildTrees,
  type Commit,
  type CommitObject,
  EDIT_KINDS,
  type EditKind,
  type FileTree,
  gitObject,
  type GitObjectType,
  identityEmail,
  parseCommit,
  parseCommitObject,
  parseMessage,
} from './git-objects';
import { lockPage, writeCurrent, type Writer } from './projections';
import { readCommit, readFiles, readHead, readObject, type Reader } from './repo';
import { cleanSummary, MAX_FILES, MAX_REVIEW_FILES, MAX_SUMMARY_LENGTH } from './rules';

/**
 * Commits a git client made, stored verbatim: their ids don't change, so the pusher's clone stays in step
 * (handoffs/git-push.md, "push identity, option (a)"). Each one is checked exactly as a web edit is
 * (`checkTree`), and stored the same way (`recordCommit`), so the rows a push leaves are a web edit's.
 *
 * What a pushed commit has to be, besides a valid change to the page:
 * - signed, as author and committer, with the identity the site gives that account on that page
 *   (`gitIdentity`): never a real name or email, which would be public history for good;
 * - on top of the page's head (fast-forward only), and not a merge: one line of commits, as the site's own;
 * - with only the headers git writes (no signature, which names its key), and a one-line summary;
 * - with trailers the site reads, and no others: `Evidence: <url>` (up to 10), `Edit-Kind: revert` with
 *   `Reverts: <commit>`, and `Bot: true` exactly when a bot account pushes.
 */

/** An object a client sent, as read from a packfile, by its id. */
export interface IncomingObject {
  type: GitObjectType;
  body: Buffer;
}

export interface RefUpdate {
  /** The head the client says it is replacing: receive-pack's old id. */
  old: string | null;
  /** The commit the head is to move to. */
  new: string;
}

export interface ReceiveOptions {
  database?: Database;
  rateLimit?: RateLimitConfig;
  /** The time to judge commit dates by. */
  now?: Date;
}

export type ReceiveResult =
  | { status: 'unchanged'; oid: string }
  | { status: 'committed'; oid: string; commits: { oid: string; seq: number; paths: string[] }[] };

/** In one push. More is a page rewritten, which the site's editors would never make either. */
export const MAX_PUSH_COMMITS = 50;
/** A commit dated later than this is a clock that's wrong, or a date made up. */
const MAX_FUTURE_SECONDS = 10 * 60;
const MAX_DEPTH = 8;
const ZERO_OID = '0'.repeat(40);
const OID = /^[0-9a-f]{40}$/;

export interface GitIdentity {
  /** `u_…`, or on a paper the account is a confirmed author of, that claim's `a_…`. */
  id: string;
  name: string;
  email: string;
  /** What to run in a clone of the page, before committing. */
  commands: string[];
}

/**
 * The `user.name` and `user.email` an account's commits to this page have to carry. The same account has
 * a different one on a paper it has claimed, so this is per page; it is what a refused push names, and
 * what a settings page or the clone instructions can show.
 */
export async function gitIdentity(
  pageId: string,
  actor: Actor & { kind: 'account' },
  database: Database = getDb(),
): Promise<GitIdentity> {
  const id = await authorIdOf(database, actor, await rolesOf(database, actor, pageId));
  return identityOf(id);
}

function identityOf(id: string): GitIdentity {
  const email = identityEmail(id);
  return { id, name: id, email, commands: [`git config user.name ${id}`, `git config user.email ${email}`] };
}

function refuse(
  message: string,
  details?: Record<string, unknown>,
  status = 422,
  code: ApiErrorCode = 'validation_error',
) {
  return new ApiError(status, code, message, details);
}

function short(oid: string): string {
  return oid.slice(0, 7);
}

/** Says which commit a refusal is about, as a `remote:` line has to. */
async function about<T>(oid: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!(err instanceof ApiError) || err.details?.commit) throw err;
    throw new ApiError(err.status, err.code, `commit ${short(oid)}: ${err.message}`, { ...err.details, commit: oid });
  }
}

/** The objects of the push, then the page's own. */
class Objects {
  private texts = new Map<string, string | null>();

  constructor(
    private db: Reader,
    private pageId: string,
    readonly incoming: ReadonlyMap<string, IncomingObject>,
  ) {}

  async get(oid: string): Promise<IncomingObject | null> {
    return this.incoming.get(oid) ?? (await readObject(this.db, this.pageId, oid));
  }

  /** Whether the page itself has the object, wherever else it is. */
  async stored(oid: string): Promise<boolean> {
    return (await readObject(this.db, this.pageId, oid)) !== null;
  }

  async must(oid: string, type: GitObjectType): Promise<Buffer> {
    const found = await this.get(oid);
    if (!found) throw refuse(`the push is missing the object ${oid}`);
    if (found.type !== type) throw refuse(`${oid} is a ${found.type}, where a ${type} was expected`);
    return found.body;
  }

  /** A blob's text, or `null` if it isn't UTF-8. */
  text = async (oid: string): Promise<string | null> => {
    if (!this.texts.has(oid)) {
      const body = await this.must(oid, 'blob');
      const text = body.toString('utf8');
      this.texts.set(oid, Buffer.from(text).equals(body) ? text : null);
    }
    return this.texts.get(oid)!;
  };

  blobSizes(): Map<string, number> {
    return new Map(
      [...this.incoming].flatMap(([oid, { type, body }]) => (type === 'blob' ? [[oid, body.length] as const] : [])),
    );
  }
}

const MODE_PROBLEMS: Record<string, string> = {
  '100755': 'is executable; pages hold plain files (git update-index --chmod=-x <path>)',
  '120000': 'is a symbolic link; pages hold plain files',
  '160000': 'is a submodule; pages hold plain files',
};

/**
 * Every file of a pushed tree, by path. Refuses what the site's own trees never hold, so the tree is exactly
 * the one `buildTrees` makes of its files: plain files and folders, in git's order, no empty folders.
 */
async function treeFiles(objects: Objects, tree: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (oid: string, prefix: string, depth: number) => {
    if (depth > MAX_DEPTH) throw refuse(`${prefix} is nested too deeply`);
    const body = await objects.must(oid, 'tree');
    for (let at = 0; at < body.length;) {
      const space = body.indexOf(0x20, at);
      const nul = space === -1 ? -1 : body.indexOf(0, space);
      if (nul === -1 || nul + 21 > body.length) throw refuse(`the tree ${oid} is malformed`);
      const mode = body.toString('latin1', at, space);
      const path = `${prefix}${body.toString('utf8', space + 1, nul)}`;
      const entry = body.toString('hex', nul + 1, nul + 21);
      at = nul + 21;
      if (mode === '40000') {
        await walk(entry, `${path}/`, depth + 1);
      } else if (mode === '100644') {
        files.set(path, entry);
        // A cap on the walk only; `checkTree` holds each kind of file to its own limit.
        if (files.size > MAX_FILES + MAX_REVIEW_FILES) {
          throw refuse(`a page can have at most ${MAX_FILES + MAX_REVIEW_FILES} files`);
        }
      } else {
        throw refuse(`${path} ${MODE_PROBLEMS[mode] ?? `has the mode ${mode}; pages hold plain files`}`, { path });
      }
    }
  };
  await walk(tree, '', 1);
  if (buildTrees(files).root !== tree) {
    throw refuse('its tree is not as git writes one (an empty folder, a name twice, or names out of order)');
  }
  return files;
}

const KNOWN_HEADERS = new Set(['tree', 'parent', 'author', 'committer', 'encoding']);
const KNOWN_TRAILERS = new Set(['Evidence', 'Edit-Kind', 'Reverts', 'Bot']);
/** `Name <someone@example.org>`, as `Signed-off-by:` and `Co-authored-by:` lines carry them. */
const NAME_AND_ADDRESS = /<[^<>\s]+@[^<>\s]+>/;

interface MessageCheck {
  id: string;
  roles: ActorRoles;
  now: Date;
  /** Commits a `Reverts:` trailer may name: the page's, and the push's before this one. */
  isCommit: (oid: string) => Promise<boolean>;
}

/** The commit's own text: its signature, headers and message. Returns what the site reads from it. */
async function checkCommitText(body: Buffer, raw: CommitObject, check: MessageCheck): Promise<Commit> {
  const { id, roles } = check;
  if (!Buffer.from(body.toString('utf8')).equals(body)) throw refuse('its message is not UTF-8');
  for (const header of raw.headers) {
    if (header === 'gpgsig' || header === 'gpgsig-sha256') {
      throw refuse(
        'it is signed, and a signature names its key, which ties the commit to you. Commit without one: ' +
          'git config commit.gpgsign false, then git commit --amend --no-edit --no-gpg-sign',
      );
    }
    if (!KNOWN_HEADERS.has(header)) throw refuse(`it has a “${header}” header, which pages don't take`);
  }
  if (raw.encoding && !/^utf-?8$/i.test(raw.encoding)) throw refuse('its message has to be UTF-8');

  for (const [role, signature] of [
    ['author', raw.author],
    ['committer', raw.committer],
  ] as const) {
    if (signature.name !== id || signature.email !== identityEmail(id)) {
      const { commands } = identityOf(id);
      throw refuse(
        // Lines, so a `remote:` line each, with the commands on their own to copy.
        [
          `its ${role} is “${signature.name} <${signature.email}>”, but your commits to this page are made as ${id},`,
          'so that no name or address of yours goes into its public history. In this clone, run',
          '',
          ...commands.map((c) => `    ${c}`),
          '',
          'then remake the commit with',
          '    git commit --amend --reset-author --no-edit',
          'or, for several commits,',
          "    git rebase --exec 'git commit --amend --reset-author --no-edit' origin/main",
        ].join('\n'),
        { identity: { name: id, email: identityEmail(id) } },
        422,
        'wrong_identity',
      );
    }
  }
  if (raw.committer.time > check.now.getTime() / 1000 + MAX_FUTURE_SECONDS) {
    throw refuse("it is dated in the future; check your computer's clock");
  }

  const { summary, trailers } = parseMessage(raw.message);
  if (summary === '' || cleanSummary(summary) !== summary) {
    throw refuse(`its message needs a first line of plain text, at most ${MAX_SUMMARY_LENGTH} characters`);
  }
  const line = raw.message.split('\n').find((l) => NAME_AND_ADDRESS.test(l));
  if (line !== undefined) {
    throw refuse(
      `its message has a name and address (“${line.trim()}”); commits here carry none, so remove it ` +
        '(git commit --amend)',
    );
  }

  const seen = new Map<string, string>();
  for (const [key, value] of trailers) {
    if (!KNOWN_TRAILERS.has(key)) {
      throw refuse(
        `it has a “${key}:” trailer; commits here take Evidence: <url>, and Edit-Kind: revert with Reverts: <commit>`,
      );
    }
    if (key !== 'Evidence' && seen.has(key)) throw refuse(`it has two “${key}:” trailers`);
    seen.set(key, value);
  }
  const evidence = trailers.filter(([key]) => key === 'Evidence').map(([, value]) => value);
  const cleaned = checkEvidence(evidence);
  if (cleaned.length !== evidence.length || cleaned.some((url, i) => url !== evidence[i])) {
    throw refuse('it gives a piece of evidence twice');
  }
  const kind = seen.get('Edit-Kind') ?? 'edit';
  if (!EDIT_KINDS.includes(kind as EditKind)) throw refuse(`Edit-Kind is “edit” or “revert”, not “${kind}”`);
  const reverts = seen.get('Reverts');
  if ((kind === 'revert') !== (reverts !== undefined)) {
    throw refuse('Edit-Kind: revert and Reverts: <commit> go together');
  }
  if (reverts !== undefined && !(OID.test(reverts) && (await check.isCommit(reverts)))) {
    throw refuse(`Reverts: names ${reverts}, which is not a commit of this page`);
  }
  const bot = seen.get('Bot');
  if (bot !== undefined && bot !== 'true') throw refuse('Bot: is only ever “true”');
  if ((bot === 'true') !== roles.bot) {
    throw refuse(
      roles.bot
        ? 'it comes from a bot account, so it needs a “Bot: true” trailer'
        : 'it says “Bot: true”, but this account is not a bot',
    );
  }
  return parseCommit(body);
}

interface Pushed {
  oid: string;
  body: Buffer;
  raw: CommitObject;
  commit: Commit;
  files: FileTree;
}

/** The pushed commits from the head up to `tip`, oldest first, each with one parent. */
async function pushedChain(objects: Objects, head: string, tip: string): Promise<Omit<Pushed, 'commit' | 'files'>[]> {
  const chain: Omit<Pushed, 'commit' | 'files'>[] = [];
  for (let oid = tip; oid !== head;) {
    if (chain.length >= MAX_PUSH_COMMITS) throw refuse(`a push can add at most ${MAX_PUSH_COMMITS} commits`);
    const found = objects.incoming.get(oid);
    // A commit the page has, the pack's copy too: a client that doesn't know the head sends all it has.
    if (!found || (await objects.stored(oid))) {
      if (found || (await objects.get(oid))) {
        throw refuse(
          `the page has commits after ${short(oid)} that this push doesn't build on; git pull --rebase, then push again`,
          { commit: oid },
          409,
          'not_fast_forward',
        );
      }
      throw refuse(`the push is missing the commit ${oid}`);
    }
    if (found.type !== 'commit') throw refuse(`${oid} is a ${found.type}, where a commit was expected`);
    let raw: CommitObject;
    try {
      raw = parseCommitObject(found.body);
    } catch {
      throw refuse(`commit ${short(oid)} is malformed`, { commit: oid });
    }
    if (raw.parents.length > 1) {
      throw refuse(
        `commit ${short(oid)} is a merge; a page's history is one line of commits, so rebase instead (git pull --rebase)`,
        { commit: oid },
      );
    }
    if (raw.parents.length === 0) {
      throw refuse(
        `commit ${short(oid)} starts a history of its own; clone the page and commit on top of it`,
        { commit: oid },
        409,
        'not_fast_forward',
      );
    }
    chain.push({ oid, body: found.body, raw });
    oid = raw.parents[0];
  }
  return chain.reverse();
}

/**
 * Checks each pushed commit against its parent: its text, then its tree (`checkTree`). Returns the commits
 * with what the site reads from them, and every GitHub address new to the page along the way.
 */
async function checkPushed(
  db: Reader,
  pageId: string,
  objects: Objects,
  chain: readonly Omit<Pushed, 'commit' | 'files'>[],
  headFiles: FileTree,
  text: Omit<MessageCheck, 'isCommit'>,
): Promise<{ pushed: Pushed[]; urls: string[][] }> {
  const pushed: Pushed[] = [];
  const urls: string[][] = [];
  const earlier = new Set<string>();
  let before = headFiles;
  for (const item of chain) {
    await about(item.oid, async () => {
      const commit = await checkCommitText(item.body, item.raw, {
        ...text,
        isCommit: async (oid) => earlier.has(oid) || (await readObject(db, pageId, oid))?.type === 'commit',
      });
      const files = await treeFiles(objects, item.raw.tree);
      urls.push(
        await checkTree(db, {
          pageId,
          roles: text.roles,
          before,
          after: files,
          text: objects.text,
          newBlobBytes: objects.blobSizes(),
        }),
      );
      pushed.push({ ...item, commit, files });
      earlier.add(item.oid);
      before = files;
    });
  }
  return { pushed, urls };
}

/**
 * Stores commits a client pushed, verbatim, moving the page's head from `update.old` to `update.new`
 * (phase 5's receive-pack calls this once per push, after reading the packfile into `objects`). All or
 * nothing: every commit between the head and `update.new` is checked first, then stored in one transaction.
 *
 * Refusals are `ApiError`s whose message is written to be shown as is (a `remote:` line) and, when one
 * commit is at fault, starts `commit <short id>:` and has `details.commit`. Codes: `fetch_first` (409, the
 * head moved), `not_fast_forward` (409), `wrong_identity` (422, `details.identity` is what to set),
 * `validation_error` (422), `forbidden` (403), `rate_limited` (429), `page_busy` (503), `paper_merged`.
 */
export async function receiveCommits(
  pageId: string,
  actor: Actor & { kind: 'account' },
  update: RefUpdate,
  incoming: ReadonlyMap<string, IncomingObject>,
  options: ReceiveOptions = {},
): Promise<ReceiveResult> {
  const { database = getDb(), rateLimit, now = new Date() } = options;
  for (const [oid, { type, body }] of incoming) {
    if (gitObject(type, body).oid !== oid) throw refuse(`the object ${oid} does not match its id`);
  }
  if (update.new === ZERO_OID) throw refuse("a page's history can't be deleted");
  if (!OID.test(update.new)) throw refuse(`${update.new} is not a commit id`);

  const head = await readHead(database, pageId);
  if (!head)
    throw refuse('this page has no history yet; clone it, which starts it, and push from that clone', undefined, 409);
  if (update.old !== head) {
    throw refuse(
      'the page has changed since you fetched it; git pull --rebase, then push again',
      { head },
      409,
      'fetch_first',
    );
  }
  if (update.new === head) return { status: 'unchanged', oid: head };

  const objects = new Objects(database, pageId, incoming);
  const chain = await pushedChain(objects, head, update.new);
  for (let i = 0; i < chain.length; i += 1) await takeCommit(actor, rateLimit);

  // Roles first, downloads last: everything that can refuse the push without GitHub runs before the copies.
  const roles = await rolesOf(database, actor, pageId);
  await checkPaper(database, pageId);
  const id = await authorIdOf(database, actor, roles);
  const headFiles = await readFiles(database, pageId, (await readCommit(database, pageId, head)).tree);
  const early = await checkPushed(database, pageId, objects, chain, headFiles, { id, roles, now });
  const snapshots = await copyDemos(database, early.urls.flat());

  try {
    return await database.transaction(async (tx) => {
      const lockedRoles = await rolesOf(tx, actor, pageId);
      await checkPaper(tx, pageId);
      await lockPage(tx, pageId);
      if ((await readHead(tx, pageId)) !== head) {
        throw refuse(
          'the page changed while the push was checked; git pull --rebase, then push again',
          undefined,
          409,
          'fetch_first',
        );
      }
      if ((await authorIdOf(tx, actor, lockedRoles)) !== id) {
        throw refuse('your identity on this page changed during the push; push again', undefined, 503, 'page_busy');
      }
      // The same checks under the lock, as a web edit's, and to hand each commit its demos' copies.
      const { pushed, urls } = await checkPushed(tx, pageId, objects, chain, headFiles, {
        id,
        roles: lockedRoles,
        now,
      });
      const commits: { oid: string; seq: number; paths: string[] }[] = [];
      for (const [index, item] of pushed.entries()) {
        const { trees } = buildTrees(item.files);
        const blobs = [...new Set(item.files.values())].flatMap((oid) => {
          const found = incoming.get(oid);
          return found?.type === 'blob' ? [{ oid, ...found }] : [];
        });
        const recorded = await about(item.oid, () =>
          recordCommit(
            tx as Writer,
            pageId,
            { oid: item.oid, type: 'commit', body: item.body },
            item.commit,
            [...blobs, ...trees],
            pinsFor(urls[index], snapshots),
          ),
        );
        commits.push({ oid: item.oid, ...recorded });
      }
      const last = pushed[pushed.length - 1];
      await writeCurrent(tx, pageId, last.oid, last.commit);
      return { status: 'committed', oid: last.oid, commits };
    });
  } catch (err) {
    throw busyError(err);
  }
}
