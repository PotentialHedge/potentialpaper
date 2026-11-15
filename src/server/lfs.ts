import { inArray } from 'drizzle-orm';
import { lfsObjects, type LfsObject } from '@/db/schema';
import type { Writer } from './pages/projections';
import type { Reader } from './pages/repo';

/**
 * The files page repos keep with Git LFS: PDFs and pictures (`rules.ts`, `lfsKindOf`). A repo holds a
 * pointer, its hash and size; the bytes are in R2 under that hash, and `lfs_objects` says where and what they
 * are. Every way of storing such bytes records them here: an upload through `git lfs` (`server/git/lfs.ts`),
 * the web editors (`card.ts`, `files.ts`) and the imports. A commit may only point at a file recorded here
 * (`check.ts`), since the site read its bytes before recording it and knows it is a PDF or a picture.
 */

export { PDF_TYPE } from './pages/rules';

export async function recordLfsObject(
  db: Pick<Writer, 'insert'>,
  file: { sha256: string; bytes: number; type: string; url: string; accountId?: string | null },
): Promise<void> {
  await db
    .insert(lfsObjects)
    .values({ ...file, accountId: file.accountId ?? null })
    .onConflictDoNothing();
}

/** The recorded files among these hashes, by hash. */
export async function findLfsObjects(db: Reader, sha256s: readonly string[]): Promise<Map<string, LfsObject>> {
  const unique = [...new Set(sha256s)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(lfsObjects).where(inArray(lfsObjects.sha256, unique));
  return new Map(rows.map((row) => [row.sha256, row]));
}
