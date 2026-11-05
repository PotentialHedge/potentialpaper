import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageObjects, paperIdentifiers } from '@/db/schema';
import { canonicalPaperId, PAPER_SCHEMES, type PaperId, type PaperScheme, parsePaperId } from '@/lib/paper-ids';
import { findPaper } from '../papers';
import { looseObject } from './git-objects';
import { readHead, toBytes } from './repo';

/**
 * Git's dumb HTTP protocol, read-only (DESIGN.md §4.6), as answers for `app/git/[...path]/route.ts`.
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

const REQUEST = /^\/git\/([a-z]+)\/(.+)\.git\/(info\/refs|HEAD|objects\/[0-9a-f]{2}\/[0-9a-f]{38})$/;

/** The address to clone a paper from. */
export function clonePath({ scheme, value }: PaperId, file = ''): string {
  return `${CLONE_PREFIX}/${scheme}/${value.split('/').map(encodeURIComponent).join('/')}.git${file}`;
}

export async function answerGitRequest(pathname: string, database: Database = getDb()): Promise<GitAnswer> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: 'missing' };
  }
  const match = REQUEST.exec(decoded);
  const scheme = match && PAPER_SCHEMES.find((s) => s === match[1]);
  if (!match || !scheme) return { kind: 'missing' };
  const [, , raw, file] = match;
  const id = parsePaperId(scheme as PaperScheme, raw);
  if (!id) return { kind: 'missing' };

  // Git asks for one object per request, so this is one query, and only ever one address's worth.
  if (file.startsWith('objects/')) {
    if (id.scheme !== scheme || id.value !== raw) return { kind: 'missing' };
    const [row] = await database
      .select({ type: pageObjects.type, body: pageObjects.body })
      .from(paperIdentifiers)
      .innerJoin(pageObjects, eq(pageObjects.paperId, paperIdentifiers.paperId))
      .where(
        and(
          eq(paperIdentifiers.scheme, id.scheme),
          eq(paperIdentifiers.value, id.value),
          eq(pageObjects.oid, toBytes(file.slice('objects/'.length).replace('/', ''))),
        ),
      );
    return row ? { kind: 'object', body: looseObject(row.type, row.body) } : { kind: 'missing' };
  }

  const found = await findPaper(id, database);
  if (!found) return { kind: 'missing' };
  const head = await readHead(database, found.paper.id);
  if (!head) return { kind: 'missing' };

  // One address per repo, so one set of cached objects. Git follows a redirect on its first request.
  const canonical = canonicalPaperId(found.identifiers) ?? id;
  if (canonical.scheme !== scheme || canonical.value !== raw) {
    return { kind: 'redirect', to: clonePath(canonical, `/${file}`) };
  }
  return { kind: 'text', body: file === 'HEAD' ? 'ref: refs/heads/main\n' : `${head}\trefs/heads/main\n` };
}
