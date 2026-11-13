import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { linkProblem, MAX_LINKS, type TitleLink } from '@/lib/paper-links';
import { ApiError } from '../api/errors';
import { storeImage } from '../media';
import { checkMayWrite } from './check';
import { commitPage, type Actor, type CommitOptions, type CommitResult } from './commit';
import { linkChanges } from './content';
import { readCommit, readFiles, readHead, readText } from './repo';
import { imageType, MAX_THUMBNAIL_BYTES, parseThumbnailPointer, THUMBNAIL_PATH, type ThumbnailPointer } from './rules';

/**
 * A paper's card: the picture beside its abstract and the links under its title. Its confirmed authors'
 * once the paper is claimed, and any verified researcher's until then (`rules.ts`).
 */

export const MAX_ALT = 500;

/** A file of the page at its head, the head, and every path there. */
async function fileAtHead(paperId: string, path: string, options: CommitOptions) {
  const database = options.database ?? getDb();
  const head = await readHead(database, paperId);
  if (!head) return { head, text: null, paths: [] };
  const commit = await readCommit(database, paperId, head);
  const files = await readFiles(database, paperId, commit.tree);
  return { head, text: await readText(database, paperId, files.get(path)), paths: [...files.keys()] };
}

export interface ThumbnailChange {
  /** A new image; without one, the current image keeps, with new words. */
  image?: Buffer;
  alt?: string;
  caption?: string;
}

/** Sets the picture, or changes its alt text and caption. */
export async function setThumbnail(
  paperId: string,
  actor: Actor,
  change: ThumbnailChange,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const { head, text } = await fileAtHead(paperId, THUMBNAIL_PATH, options);
  const current = text === null ? null : parseThumbnailPointer(text);
  let image: Pick<ThumbnailPointer, 'sha256' | 'bytes' | 'type' | 'url'>;
  if (change.image) {
    // Storing the picture is slow and leaves a file behind, so only for someone the commit would take it from.
    await checkMayWrite(options.database ?? getDb(), paperId, actor, [THUMBNAIL_PATH]);
    const type = imageType(change.image);
    if (!type) throw new ApiError(422, 'validation_error', 'the picture has to be a JPEG, PNG, GIF, WebP or AVIF');
    if (change.image.length > MAX_THUMBNAIL_BYTES) {
      throw new ApiError(422, 'validation_error', `the picture is larger than ${MAX_THUMBNAIL_BYTES / 1024 / 1024} MB`);
    }
    const sha256 = createHash('sha256').update(change.image).digest('hex');
    image = { sha256, bytes: change.image.length, type, url: await storeImage(change.image, sha256, type) };
  } else if (current) {
    image = current;
  } else {
    throw new ApiError(422, 'validation_error', 'choose a picture');
  }
  const alt = change.alt?.trim().slice(0, MAX_ALT);
  const caption = change.caption?.trim().slice(0, MAX_ALT);
  const pointer: ThumbnailPointer = {
    sha256: image.sha256,
    bytes: image.bytes,
    type: image.type,
    url: image.url,
    ...(alt ? { alt } : {}),
    ...(caption ? { caption } : {}),
  };
  return commitPage(
    paperId,
    head,
    actor,
    [{ path: THUMBNAIL_PATH, content: `${JSON.stringify(pointer, null, 2)}\n` }],
    change.image ? 'Change the picture' : "Change the picture's words",
    options,
  );
}

/** Goes back to the PDF's first page. */
export async function removeThumbnail(paperId: string, actor: Actor, options: CommitOptions = {}) {
  const { head } = await fileAtHead(paperId, THUMBNAIL_PATH, options);
  return commitPage(paperId, head, actor, [{ path: THUMBNAIL_PATH, content: null }], 'Remove the picture', options);
}

/** Replaces the page's own links, a file each in `links/`, in order. An empty list removes them all. */
export async function setLinks(
  paperId: string,
  actor: Actor,
  links: readonly TitleLink[],
  options: CommitOptions = {},
  summary?: string,
): Promise<CommitResult> {
  if (links.length > MAX_LINKS) throw new ApiError(422, 'validation_error', `at most ${MAX_LINKS} links`);
  const clean = links.map((link) => ({ label: link.label.trim(), url: link.url.trim() }));
  const labels = new Set<string>();
  for (const [index, link] of clean.entries()) {
    const problem = linkProblem(link);
    if (problem) throw new ApiError(422, 'validation_error', `link ${index + 1} ${problem}`, { index });
    if (labels.has(link.label.toLowerCase())) {
      throw new ApiError(422, 'validation_error', `two links are called “${link.label}”`, { index });
    }
    labels.add(link.label.toLowerCase());
  }
  const { head, paths } = await fileAtHead(paperId, THUMBNAIL_PATH, options);
  return commitPage(paperId, head, actor, linkChanges(paths, clean), summary?.trim() || 'Change the links', options);
}
