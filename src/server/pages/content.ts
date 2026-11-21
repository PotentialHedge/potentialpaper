import { encodeLinkFile, parseLinkFile, type TitleLink } from '@/lib/paper-links';
import { encodeVersionFile, parseVersionFile, sortVersions, type PaperVersion } from '@/lib/versions';
import { findLfsObjects } from '../lfs';
import type { FileChange } from './commit';
import { readText, type Reader } from './repo';
import {
  encodeLfsPointer,
  isLinkPath,
  LINKS_DIR,
  parseLfsPointer,
  parseThumbnailWords,
  THUMBNAIL_PATH,
  thumbnailImageType,
  versionIdOf,
  versionPath,
  versionPdfPath,
  type LfsPointer,
  type ThumbnailPointer,
} from './rules';
import { slugOf } from './sections';

/**
 * The page's directories of small JSON files, `versions/` and `links/`, and its PDFs and picture, read from
 * a tree and written back. A PDF or the picture is a Git LFS pointer, which says its hash and size; where
 * its bytes are comes from `lfs_objects` (`server/lfs.ts`).
 */

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Where the bytes of each of these hashes are, for those this site stored. */
export type UrlOf = (sha256: string) => string | undefined;

/**
 * The versions in a tree given as path to text, oldest first, each with its PDF if `versions/<id>.pdf` is a
 * pointer to bytes `urlOf` knows. A file that isn't a version is left out, as the commit refuses them.
 */
export function versionsIn(texts: ReadonlyMap<string, string>, urlOf: UrlOf): PaperVersion[] {
  const versions: PaperVersion[] = [];
  for (const [path, text] of texts) {
    const id = versionIdOf(path);
    if (!id) continue;
    const parsed = parseVersionFile(id, text);
    if (!('version' in parsed)) continue;
    const version = parsed.version;
    const pointer = parseLfsPointer(texts.get(versionPdfPath(id)) ?? '');
    const url = pointer && urlOf(pointer.sha256);
    if (pointer && url) version.pdf = { sha256: pointer.sha256, bytes: pointer.bytes, url, ...parsed.pdfInfo };
    versions.push(version);
  }
  return sortVersions(versions.sort((a, b) => byBytes(a.id, b.id)));
}

/** The text of each file of a tree that `pick` wants. */
async function textsOf(
  db: Reader,
  pageId: string,
  files: ReadonlyMap<string, string>,
  pick: (path: string) => boolean,
): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  for (const [path, blob] of files) {
    if (!pick(path)) continue;
    const text = await readText(db, pageId, blob);
    if (text !== null) texts.set(path, text);
  }
  return texts;
}

/** Where the bytes of the pointers among these texts are. */
async function urlsFor(db: Reader, texts: Iterable<string>): Promise<UrlOf> {
  const sha256s = [...texts].map((text) => parseLfsPointer(text)?.sha256).filter((sha) => sha !== undefined);
  const found = await findLfsObjects(db, sha256s);
  return (sha256) => found.get(sha256)?.url;
}

/** The versions in a tree, oldest first, with their PDFs. */
export async function readVersions(
  db: Reader,
  pageId: string,
  files: ReadonlyMap<string, string>,
): Promise<PaperVersion[]> {
  const texts = await textsOf(db, pageId, files, (path) => path.startsWith('versions/'));
  return versionsIn(texts, await urlsFor(db, texts.values()));
}

/**
 * The changes that make `before` into `after`, a version to a file, and its PDF to a pointer beside it.
 * Only a PDF's hash and size go in the pointer, so its bytes have to be recorded in `lfs_objects` already.
 */
export function versionChanges(before: readonly PaperVersion[], after: readonly PaperVersion[]): FileChange[] {
  const filesOf = (versions: readonly PaperVersion[]) => {
    const files = new Map<string, string>();
    for (const v of versions) {
      files.set(versionPath(v.id), encodeVersionFile(v));
      if (v.pdf) files.set(versionPdfPath(v.id), encodeLfsPointer(v.pdf));
    }
    return files;
  };
  const was = filesOf(before);
  const now = filesOf(after);
  const changes: FileChange[] = [];
  for (const path of was.keys()) if (!now.has(path)) changes.push({ path, content: null });
  for (const [path, text] of now) if (was.get(path) !== text) changes.push({ path, content: text });
  return changes;
}

/** The picture's file in a tree (`thumbnail.png`, …), if there is one. */
export function thumbnailImagePathIn(paths: Iterable<string>): string | null {
  for (const path of paths) if (thumbnailImageType(path)) return path;
  return null;
}

/** The paper's picture, from `thumbnail.<ext>` and the words in `thumbnail.json`, if its bytes are known. */
export async function readThumbnail(
  db: Reader,
  pageId: string,
  files: ReadonlyMap<string, string>,
): Promise<ThumbnailPointer | null> {
  const path = thumbnailImagePathIn(files.keys());
  const pointer: LfsPointer | null = path ? parseLfsPointer((await readText(db, pageId, files.get(path))) ?? '') : null;
  if (!path || !pointer) return null;
  const object = (await findLfsObjects(db, [pointer.sha256])).get(pointer.sha256);
  if (!object) return null;
  const words = parseThumbnailWords((await readText(db, pageId, files.get(THUMBNAIL_PATH))) ?? '{}') ?? {};
  return { sha256: pointer.sha256, bytes: pointer.bytes, type: thumbnailImageType(path)!, url: object.url, ...words };
}

/** The links in a tree, in the order of their files' names. */
export async function readLinks(db: Reader, pageId: string, files: ReadonlyMap<string, string>): Promise<TitleLink[]> {
  const links: TitleLink[] = [];
  const paths = [...files.keys()].filter(isLinkPath).sort(byBytes);
  for (const path of paths) {
    const link = parseLinkFile((await readText(db, pageId, files.get(path))) ?? '');
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
