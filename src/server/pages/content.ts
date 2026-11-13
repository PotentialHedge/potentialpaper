import { encodeLinkFile, parseLinkFile, type TitleLink } from '@/lib/paper-links';
import { encodeVersionFile, parseVersionFile, sortVersions, type PaperVersion } from '@/lib/versions';
import type { FileChange } from './commit';
import { readText, type Reader } from './repo';
import { isLinkPath, LINKS_DIR, versionIdOf, versionPath } from './rules';
import { slugOf } from './sections';

/** The page's directories of small JSON files, `versions/` and `links/`, read from a tree and written back. */

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The versions in a tree, oldest first. A file that isn't one is left out, as the commit refuses them. */
export async function readVersions(
  db: Reader,
  paperId: string,
  files: ReadonlyMap<string, string>,
): Promise<PaperVersion[]> {
  const versions: PaperVersion[] = [];
  for (const [path, blob] of files) {
    const id = versionIdOf(path);
    if (!id) continue;
    const parsed = parseVersionFile(id, (await readText(db, paperId, blob)) ?? '');
    if ('version' in parsed) versions.push(parsed.version);
  }
  return sortVersions(versions.sort((a, b) => byBytes(a.id, b.id)));
}

/** The changes that make `before` into `after`, a version to a file. */
export function versionChanges(before: readonly PaperVersion[], after: readonly PaperVersion[]): FileChange[] {
  const was = new Map(before.map((v) => [v.id, encodeVersionFile(v)]));
  const now = new Map(after.map((v) => [v.id, encodeVersionFile(v)]));
  const changes: FileChange[] = [];
  for (const id of was.keys()) if (!now.has(id)) changes.push({ path: versionPath(id), content: null });
  for (const [id, text] of now) if (was.get(id) !== text) changes.push({ path: versionPath(id), content: text });
  return changes;
}

/** The links in a tree, in the order of their files' names. */
export async function readLinks(db: Reader, paperId: string, files: ReadonlyMap<string, string>): Promise<TitleLink[]> {
  const links: TitleLink[] = [];
  const paths = [...files.keys()].filter(isLinkPath).sort(byBytes);
  for (const path of paths) {
    const link = parseLinkFile((await readText(db, paperId, files.get(path))) ?? '');
    if (link) links.push(link);
  }
  return links;
}

/**
 * The changes that make the links directory hold `links`, in their order: `links/10-code.json`, … A list
 * that is the same but for one link changes one file.
 */
export function linkChanges(paths: Iterable<string>, links: readonly TitleLink[]): FileChange[] {
  const old = [...paths].filter(isLinkPath);
  const step = Math.min(10, Math.floor(99 / Math.max(1, links.length)));
  const next = new Map<string, string>();
  for (const [i, link] of links.entries()) {
    const base = `${LINKS_DIR}/${String(step * (i + 1)).padStart(2, '0')}-${slugOf(link.label)}`;
    let path = `${base}.json`;
    for (let n = 2; next.has(path); n += 1) path = `${base}-${n}.json`;
    next.set(path, encodeLinkFile(link));
  }
  return [
    ...old.filter((path) => !next.has(path)).map((path) => ({ path, content: null })),
    ...[...next].map(([path, content]) => ({ path, content })),
  ];
}
