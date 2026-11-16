import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { paperIdentifiers } from '@/db/schema';
import { canonicalPaperId, PAPER_SCHEMES, type PaperId, type PaperScheme, parsePaperId } from '@/lib/paper-ids';
import { findPaper } from '../papers';
import { gitSshUrl, siteUrl } from '../site';
import { looseObject } from './git-objects';
import { pageRepo, readHead } from '../git/repo';

/**
 * Clone addresses, and git's dumb HTTP protocol, read-only (DESIGN.md §4.6), as answers for
 * `server/git/http.ts`. The smart protocol is in `server/git/`.
 *
 * The addresses are unbounded, so this only reads. It never asks a paper source about an identifier and
 * never writes a row, and each answer but an object that exists says not to cache it.
 */

export type GitAnswer =
  | { kind: 'text'; body: string }
  | { kind: 'object'; body: Buffer }
  | { kind: 'redirect'; to: string }
  | { kind: 'missing' };

export const CLONE_PREFIX = '/git';

const REQUEST =
  /^\/git\/([a-z]+)\/(.+)\.git\/(info\/refs|HEAD|objects\/[0-9a-f]{2}\/[0-9a-f]{38}|git-upload-pack|git-receive-pack|info\/lfs\/objects\/batch|info\/lfs\/objects\/[0-9a-f]{64}|info\/lfs\/locks(?:\/verify)?)$/;

/** A clone address, taken apart: the paper as written in it, and the file asked for under `.git/`. */
export interface GitAddress {
  id: PaperId;
  /** The scheme and identifier exactly as the address spells them, to compare with the canonical ones. */
  scheme: PaperScheme;
  raw: string;
  file: string;
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
  const scheme = match && PAPER_SCHEMES.find((s) => s === match[1]);
  if (!match || !scheme) return null;
  const [, , raw, file] = match;
  const id = parsePaperId(scheme as PaperScheme, raw);
  return id ? { id, scheme: scheme as PaperScheme, raw, file } : null;
}

/** The address to clone a paper from. */
export function clonePath({ scheme, value }: PaperId, file = ''): string {
  return `${CLONE_PREFIX}/${scheme}/${value.split('/').map(encodeURIComponent).join('/')}.git${file}`;
}

/**
 * The page repo an address names: its paper, if that has a repo, or the one address of it to go to instead.
 * One address per repo, so one set of cached objects. Git follows a redirect on its first request.
 */
export async function findRepo(
  { id, scheme, raw, file }: GitAddress,
  database: Database = getDb(),
): Promise<
  | { kind: 'repo'; paperId: string; head: string; identifiers: PaperId[] }
  | { kind: 'redirect'; to: string }
  | { kind: 'missing' }
> {
  const found = await findPaper(id, database);
  if (!found) return { kind: 'missing' };
  const head = await readHead(database, found.paper.id);
  if (!head) return { kind: 'missing' };
  const canonical = canonicalPaperId(found.identifiers) ?? id;
  if (canonical.scheme !== scheme || canonical.value !== raw) {
    return { kind: 'redirect', to: clonePath(canonical, `/${file}`) };
  }
  return { kind: 'repo', paperId: found.paper.id, head, identifiers: found.identifiers };
}

/** The dumb protocol's answers: `info/refs`, `HEAD` and loose objects. */
export async function answerGitRequest(pathname: string, database: Database = getDb()): Promise<GitAnswer> {
  const address = parseGitAddress(pathname);
  if (!address || address.file.startsWith('git-') || address.file.startsWith('info/lfs/')) return { kind: 'missing' };
  const { id, scheme, raw, file } = address;

  // Git asks for one object per request, so this reads one object, and only ever one address's worth.
  if (file.startsWith('objects/')) {
    if (id.scheme !== scheme || id.value !== raw) return { kind: 'missing' };
    const [identifier] = await database
      .select({ paperId: paperIdentifiers.paperId })
      .from(paperIdentifiers)
      .where(and(eq(paperIdentifiers.scheme, id.scheme), eq(paperIdentifiers.value, id.value)));
    if (!identifier) return { kind: 'missing' };
    const oid = file.slice('objects/'.length).replace('/', '');
    const object = (await pageRepo(database, identifier.paperId).read([oid])).get(oid);
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
export function cloneAddresses(id: PaperId): { https: string; ssh: string | null } {
  return {
    https: `${siteUrl()}${clonePath(id)}`,
    ssh: process.env.GIT_SSH_URL ? `${gitSshUrl()}${clonePath(id).slice(CLONE_PREFIX.length)}` : null,
  };
}
