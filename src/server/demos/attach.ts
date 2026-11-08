import { inArray } from 'drizzle-orm';
import { getDb } from '@/db';
import { demoSnapshots } from '@/db/schema';
import type { DemoSource } from '@/lib/demos';
import { ApiError } from '../api/errors';
import type { Reader } from '../pages/repo';
import { demoIds } from '../pages/markdown';

/**
 * Demos live in a page's Markdown, as ```` ```demo <snapshot> ```` blocks. Copying the files from GitHub
 * (`snapshot.ts`) makes the snapshot; writing the block into a section is an ordinary edit.
 */

/** Where each named snapshot came from. Snapshots never change, so a rebuild reads the same. */
export async function demoSources(db: Reader, ids: readonly string[]): Promise<Map<string, DemoSource>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: demoSnapshots.id,
      source: demoSnapshots.source,
      commit: demoSnapshots.commit,
      root: demoSnapshots.root,
    })
    .from(demoSnapshots)
    .where(inArray(demoSnapshots.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The sources of the Markdown's demos, refusing a block that names a snapshot this site doesn't have. */
export async function checkedDemoSources(markdown: string, db: Reader = getDb()): Promise<Map<string, DemoSource>> {
  const ids = demoIds(markdown);
  const sources = await demoSources(db, ids);
  const missing = ids.filter((id) => !sources.has(id));
  if (missing.length > 0) {
    throw new ApiError(422, 'validation_error', 'a demo block names a demo that is not on this site; insert it again', {
      missing,
    });
  }
  return sources;
}
