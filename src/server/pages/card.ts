import { createHash } from 'node:crypto';
import { getDb } from '@/db';
import { linkProblem, MAX_LINKS, type TitleLink } from '@/lib/paper-links';
import { ApiError } from '../api/errors';
import { storeImage } from '../media';
import { checkMayWrite } from './check';
import { recordLfsObject } from '../lfs';
import { commitPage, type Actor, type CommitOptions, type CommitResult, type FileChange } from './commit';
import { linkChanges, thumbnailImagePathIn } from './content';
import { readCommit, readFiles, readHead } from './repo';
import {
  encodeLfsPointer,
  encodeThumbnailWords,
  imageType,
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_PATH,
  thumbnailImagePath,
} from './rules';

/**
 * A paper's card: the picture beside its abstract and the links under its title. Its confirmed authors'
 * once the paper is claimed, and any verified researcher's until then (`rules.ts`).
 */

export const MAX_ALT = 500;

/** The page's files at its head, and the head. */
async function filesAtHead(paperId: string, options: CommitOptions) {
  const database = options.database ?? getDb();
  const head = await readHead(database, paperId);
  if (!head) return { database, head, files: new Map<string, string>() };
  const commit = await readCommit(database, paperId, head);
  return { database, head, files: await readFiles(database, paperId, commit.tree) };
}

export interface ThumbnailChange {
  /** A new image; without one, the current image keeps, with new words. */
  image?: Buffer;
  alt?: string;
  caption?: string;
}

/**
 * Sets the picture, or changes its alt text and caption: `thumbnail.<ext>`, a Git LFS pointer to the bytes
 * stored here, and `thumbnail.json` beside it, as a push would.
 */
export async function setThumbnail(
  paperId: string,
  actor: Actor,
  change: ThumbnailChange,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const { database, head, files } = await filesAtHead(paperId, options);
  const currentPath = thumbnailImagePathIn(files.keys());
  const changes: FileChange[] = [];
  if (change.image) {
    // Storing the picture is slow and leaves a file behind, so only for someone the commit would take it from.
    await checkMayWrite(database, paperId, actor, [THUMBNAIL_PATH]);
    const type = imageType(change.image);
    if (!type) throw new ApiError(422, 'validation_error', 'the picture has to be a JPEG, PNG, GIF, WebP or AVIF');
    if (change.image.length > MAX_THUMBNAIL_BYTES) {
      throw new ApiError(422, 'validation_error', `the picture is larger than ${MAX_THUMBNAIL_BYTES / 1024 / 1024} MB`);
    }
    const sha256 = createHash('sha256').update(change.image).digest('hex');
    const url = await storeImage(change.image, sha256, type);
    await recordLfsObject(database, {
      sha256,
      bytes: change.image.length,
      type,
      url,
      accountId: actor.kind === 'account' ? actor.accountId : null,
    });
    const path = thumbnailImagePath(type);
    if (currentPath && currentPath !== path) changes.push({ path: currentPath, content: null });
    changes.push({ path, content: encodeLfsPointer({ sha256, bytes: change.image.length }) });
  } else if (!currentPath) {
    throw new ApiError(422, 'validation_error', 'choose a picture');
  }
  const alt = change.alt?.trim().slice(0, MAX_ALT);
  const caption = change.caption?.trim().slice(0, MAX_ALT);
  changes.push({ path: THUMBNAIL_PATH, content: alt || caption ? encodeThumbnailWords({ alt, caption }) : null });
  return commitPage(
    paperId,
    head,
    actor,
    changes.filter((c) => c.content !== null || files.has(c.path)),
    change.image ? 'Change the picture' : "Change the picture's words",
    options,
  );
}

/** Goes back to the PDF's first page. */
export async function removeThumbnail(paperId: string, actor: Actor, options: CommitOptions = {}) {
  const { head, files } = await filesAtHead(paperId, options);
  const paths = [thumbnailImagePathIn(files.keys()), THUMBNAIL_PATH].filter((p) => p !== null && files.has(p));
  return commitPage(
    paperId,
    head,
    actor,
    paths.map((path) => ({ path: path!, content: null })),
    'Remove the picture',
    options,
  );
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
  const { head, files } = await filesAtHead(paperId, options);
  return commitPage(
    paperId,
    head,
    actor,
    linkChanges(files.keys(), clean),
    summary?.trim() || 'Change the links',
    options,
  );
}
