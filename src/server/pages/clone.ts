import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pages, paperIdentifiers } from '@/db/schema';
import { isPageKind, KINDS, keyProblem, type PageAddress } from '@/lib/kinds';
import { canonicalPaperId, PAPER_SCHEMES, type PaperId, parsePaperId } from '@/lib/paper-ids';
import { findPaper } from '../papers';
import { findKeyedPage, type PageRow } from './kinds';
import { gitSshUrl, siteUrl } from '../site';
import { looseObject } from './git-objects';
import { pageRepo, readHead } from '../git/repo';
import { ApiError } from '../api/errors';
import { consume, type RateLimitConfig } from '../ratelimit';
import { startRepo } from './commit';
import { refreshPages } from './refresh';

/**
 * Clone addresses, and git's dumb HTTP protocol, read-only (DESIGN.md §4.6), as answers for
 * `server/git/http.ts`. The smart protocol is in `server/git/`.
 *
 * The addresses are unbounded, so this only reads, with one exception: a clone of a paper that has no repo yet
 * starts it (`findRepo`'s `start`), bounded per address it comes from. It never asks a paper source about an
 * identifier, and each answer but an object that exists says not to cache it.
 */

export type GitAnswer =
  | { kind: 'text'; body: string }
  | { kind: 'object'; body: Buffer }
  | { kind: 'redirect'; to: string }
  | { kind: 'missing' };

export const CLONE_PREFIX = '/git';

const REQUEST =
  /^\/git\/([a-z]+)\/(.+)\.git\/(info\/refs|HEAD|objects\/[0-9a-f]{2}\/[0-9a-f]{38}|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/objects\/[0-9a-f]{64}|info\/lfs\/locks(?:\/verify)?)$/;

/**
 * A clone address, taken apart: the page as written in it, and the file asked for under `.git/`. A paper's is
 * `/git/<scheme>/<identifier>.git` (`arxiv`, `doi`, `openreview`); any other kind's `/git/<kind>/<key>.git`
 * (`/git/venue/iclr/2027.git`, `/git/category/linear-attention.git`), as its identifier is `<kind>:<key>`.
 */
export interface GitAddress {
  page: PageAddress;
  /** The scheme (or kind) and identifier exactly as the address spells them, to compare with the canonical ones. */
  scheme: string;
  raw: string;
  file: string;
}

/** The page a scheme and an identifier name, as a clone address spells them, or `null`. */
export function gitPageAddress(scheme: string, raw: string): PageAddress | null {
  const paperScheme = PAPER_SCHEMES.find((s) => s === scheme);
  if (paperScheme) {
    const id = parsePaperId(paperScheme, raw);
    return id && { kind: 'paper', id };
  }
  if (!isPageKind(scheme) || scheme === 'paper') return null;
  return keyProblem(scheme, raw) ? null : { kind: scheme, key: raw };
}

/** The clone address in a path, or `null` for anything that isn't one. */
export function parseGitAddress(pathname: string): GitAddress | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const match = REQUEST.exec(decoded);
  if (!match) return null;
  const [, scheme, raw, file] = match;
  const page = gitPageAddress(scheme, raw);
  return page ? { page, scheme, raw, file } : null;
}

/** The address to clone a paper from. */
export function clonePath({ scheme, value }: PaperId, file = ''): string {
  return `${CLONE_PREFIX}/${scheme}/${value.split('/').map(encodeURIComponent).join('/')}.git${file}`;
}

/** The address to clone any page from. */
export function pageClonePath(page: PageAddress, file = ''): string {
  if (page.kind === 'paper') return clonePath(page.id, file);
  return `${CLONE_PREFIX}/${page.kind}/${page.key.split('/').map(encodeURIComponent).join('/')}.git${file}`;
}

/** The page repo `findRepo` found. */
export interface FoundRepo {
  kind: 'repo';
  pageId: string;
  page: PageRow;
  /** The page's public address, in its canonical form. */
  address: PageAddress;
  head: string;
  /** A paper's identifiers; none for other kinds. */
  identifiers: PaperId[];
}

/** How many papers' repos one address (an IP, or an account over SSH) may start by cloning them: a person's worth. */
export const REPO_START_LIMIT: RateLimitConfig = { burst: 30, perSecond: 30 / 3600 };

export interface FindOptions {
  /**
   * A git client is fetching (`git-upload-pack`): start the repo of a paper that has none yet (`startRepo`), so it
   * can be cloned, taking one from the bucket of `start.by`. Without it such a paper has no repo to answer with.
   */
  start?: { by: string };
}

/**
 * The page repo an address names: its paper, if that has a repo (or `start` starts one), or the one address of it
 * to go to instead. One address per repo, so one set of cached objects. Git follows a redirect on its first request.
 * Throws `429` when `start` would start one and its bucket is empty.
 */
export async function findRepo(
  { page, scheme, raw, file }: GitAddress,
  database: Database = getDb(),
  { start }: FindOptions = {},
): Promise<FoundRepo | { kind: 'redirect'; to: string } | { kind: 'missing' }> {
  if (!KINDS[page.kind].repo) return { kind: 'missing' };
  if (page.kind !== 'paper') {
    const row = await findKeyedPage(database, page.kind, page.key);
    if (!row) return { kind: 'missing' };
    const head = await readHead(database, row.id);
    if (!head) return { kind: 'missing' };
    if (scheme !== page.kind || raw !== page.key) return { kind: 'redirect', to: pageClonePath(page, `/${file}`) };
    return { kind: 'repo', pageId: row.id, page: row, address: page, head, identifiers: [] };
  }
  const { id } = page;
  const found = await findPaper(id, database);
  if (!found) return { kind: 'missing' };
  let head = await readHead(database, found.paper.id);
  if (!head && !start) return { kind: 'missing' };
  const canonical = canonicalPaperId(found.identifiers) ?? id;
  if (canonical.scheme !== scheme || canonical.value !== raw) {
    return { kind: 'redirect', to: clonePath(canonical, `/${file}`) };
  }
  if (!head && start) {
    const limit = await consume(`repo-start:${start.by}`, REPO_START_LIMIT);
    if (!limit.allowed) {
      throw new ApiError(429, 'rate_limited', `too many new clones; try again in ${limit.retryAfterSeconds} seconds`, {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    head = await startRepo(found.paper.id, database);
    // The page now offers its clone address and has a history.
    await refreshPages({ kind: 'paper', id: canonical }, found.identifiers).catch((err) =>
      console.error('refreshing a page after starting its repo', err),
    );
  }
  if (!head) return { kind: 'missing' };
  const [short] = await database.select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, found.paper.id));
  return {
    kind: 'repo',
    pageId: found.paper.id,
    page: { id: found.paper.id, kind: 'paper', key: found.paper.id },
    address: { kind: 'paper', id: canonical, ...(short ? { shortId: short.shortId } : {}) },
    head,
    identifiers: found.identifiers,
  };
}

/** The page whose objects an address may read: only at its own spelling, never through a redirect. */
async function objectPageId(
  page: PageAddress,
  scheme: string,
  raw: string,
  database: Database,
): Promise<string | null> {
  if (page.kind !== 'paper') {
    if (scheme !== page.kind || raw !== page.key) return null;
    return (await findKeyedPage(database, page.kind, page.key))?.id ?? null;
  }
  const { id } = page;
  if (id.scheme !== scheme || id.value !== raw) return null;
  const [identifier] = await database
    .select({ pageId: paperIdentifiers.paperId })
    .from(paperIdentifiers)
    .where(and(eq(paperIdentifiers.scheme, id.scheme), eq(paperIdentifiers.value, id.value)));
  return identifier?.pageId ?? null;
}

/** The dumb protocol's answers: `info/refs`, `HEAD` and loose objects. */
export async function answerGitRequest(pathname: string, database: Database = getDb()): Promise<GitAnswer> {
  const address = parseGitAddress(pathname);
  if (!address || address.file.startsWith('git-') || address.file.startsWith('info/lfs/')) return { kind: 'missing' };
  const { page, scheme, raw, file } = address;

  // Git asks for one object per request, so this reads one object, and only ever one address's worth.
  if (file.startsWith('objects/')) {
    const pageId = await objectPageId(page, scheme, raw, database);
    if (!pageId) return { kind: 'missing' };
    const oid = file.slice('objects/'.length).replace('/', '');
    const object = (await pageRepo(database, pageId).read([oid])).get(oid);
    return object ? { kind: 'object', body: looseObject(object.type, object.body) } : { kind: 'missing' };
  }

  const repo = await findRepo(address, database);
  if (repo.kind !== 'repo') return repo;
  return { kind: 'text', body: file === 'HEAD' ? 'ref: refs/heads/main\n' : `${repo.head}\trefs/heads/main\n` };
}

/**
 * The addresses to clone a paper's page from, as the Edit dialog shows them: HTTPS always, SSH only once its
 * server is set up (`GIT_SSH_URL`, DEPLOY.md "Git over SSH").
 */
export function cloneAddresses(id: PaperId | PageAddress): { https: string; ssh: string | null } {
  const path = 'kind' in id ? pageClonePath(id) : clonePath(id);
  return {
    https: `${siteUrl()}${path}`,
    ssh: process.env.GIT_SSH_URL ? `${gitSshUrl()}${path.slice(CLONE_PREFIX.length)}` : null,
  };
}
