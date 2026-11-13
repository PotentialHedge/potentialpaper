import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { demoSnapshots, type DemoFile } from '@/db/schema';
import { DEMOS_DIR, PAGE_SOURCE_PREFIX, type DemoSource } from '@/lib/demos';
import type { Writer } from '../pages/projections';
import { readObject } from '../pages/repo';
import { demoPath } from '../pages/rules';
import { contentType } from './snapshot';
import { hasBlob, putBlob } from './store';

/**
 * Demos kept in a page's own repo, `demos/<name>/` (`pages/rules.ts`). Each folder, as it is at a commit,
 * becomes a snapshot like one copied from GitHub, so the demo host serves both the same way: its files go
 * to the blob store and a `demo_snapshots` row lists them. That happens when a page's projection is
 * written (`projections.ts`), so a rebuild makes any that are missing.
 */

/** Each demo folder's files, by their path inside it, as git blob ids. */
export function demoFolders(files: ReadonlyMap<string, string>): Map<string, Map<string, string>> {
  const folders = new Map<string, Map<string, string>>();
  for (const [path, oid] of files) {
    const demo = demoPath(path);
    if (!demo) continue;
    if (!folders.has(demo.name)) folders.set(demo.name, new Map());
    folders.get(demo.name)!.set(demo.inside, oid);
  }
  return folders;
}

/**
 * The folder's snapshot id: a hash of the page, the folder and its git blob ids, so it is known without
 * reading the files, and the same folder at another commit is the same snapshot.
 */
export function pageDemoId(paperId: string, name: string, folder: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256').update(`${PAGE_SOURCE_PREFIX}${paperId}\0${DEMOS_DIR}/${name}\n`);
  for (const path of [...folder.keys()].sort()) hash.update(`${path}\0${folder.get(path)}\n`);
  return hash.digest('hex').slice(0, 32);
}

/**
 * The snapshot of `demos/<name>/` as it is at `commit`, made the first time this exact folder is seen. `null`
 * if the folder has no `index.html`, which a commit refuses anyway.
 */
export async function pageDemoSnapshot(
  tx: Writer,
  paperId: string,
  commit: string,
  name: string,
  folder: ReadonlyMap<string, string>,
): Promise<DemoSource | null> {
  if (!folder.has('index.html')) return null;
  const id = pageDemoId(paperId, name, folder);
  const [known] = await tx
    .select({
      id: demoSnapshots.id,
      source: demoSnapshots.source,
      commit: demoSnapshots.commit,
      root: demoSnapshots.root,
    })
    .from(demoSnapshots)
    .where(eq(demoSnapshots.id, id));
  if (known) return known;

  const files: Record<string, DemoFile> = {};
  let totalBytes = 0;
  for (const [path, oid] of folder) {
    const blob = await readObject(tx, paperId, oid);
    if (!blob || blob.type !== 'blob') throw new Error(`page ${paperId} has no blob ${oid}`);
    const sha256 = createHash('sha256').update(blob.body).digest('hex');
    // Bytes first, so a snapshot row never names a file that isn't stored.
    if (!(await hasBlob(sha256))) await putBlob(sha256, blob.body);
    files[path] = { sha256, bytes: blob.body.length, type: contentType(path) };
    totalBytes += blob.body.length;
  }
  const row = { id, source: `${PAGE_SOURCE_PREFIX}${paperId}`, commit, root: `${DEMOS_DIR}/${name}` };
  await tx
    .insert(demoSnapshots)
    .values({ ...row, files, totalBytes })
    .onConflictDoNothing();
  return row;
}
