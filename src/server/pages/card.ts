import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { getDb } from '@/db';
import { encodeLinksFile, linkProblem, MAX_LINKS, type TitleLink } from '@/lib/paper-links';
import { ApiError } from '../api/errors';
import { commitPage, type Actor, type CommitOptions, type CommitResult } from './commit';
import { readCommit, readFiles, readHead, readText } from './repo';
import {
  imageType,
  LINKS_PATH,
  MAX_THUMBNAIL_BYTES,
  parseThumbnailPointer,
  THUMBNAIL_PATH,
  type ThumbnailPointer,
  type ThumbnailType,
} from './rules';

/**
 * A paper's card: the picture beside its abstract and the links under its title. Its confirmed authors'
 * once the paper is claimed, and any verified researcher's until then (`rules.ts`).
 */

const BUCKET = process.env.R2_BUCKET ?? 'papertrail-pdfs';
const MEDIA_BASE = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
const EXTENSIONS: Record<ThumbnailType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};
export const MAX_ALT = 500;

/**
 * Stores an image under its hash and returns its address: in R2 when its keys are set, and otherwise,
 * in development, under `public/thumbnails` (or `THUMBNAILS_DIR`), served by this site.
 */
export function storeImage(bytes: Buffer, sha256: string, type: ThumbnailType): Promise<string> {
  return storeMedia(bytes, `${sha256}.${EXTENSIONS[type]}`, type, {
    folder: 'thumbnail',
    devDir: process.env.THUMBNAILS_DIR,
    devPath: '/thumbnails',
  });
}

/**
 * Stores bytes as `folder/name` in R2 when its keys are set, and returns their public address. Without the
 * keys, in development, writes them to `devDir` (by default `public` + `devPath`), which this site serves.
 */
export async function storeMedia(
  bytes: Buffer,
  name: string,
  contentType: string,
  { folder, devDir, devPath }: { folder: string; devDir?: string; devPath: string },
): Promise<string> {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    if (process.env.NODE_ENV === 'production' && !devDir) {
      throw new Error(`${folder} storage: set the R2_* keys`);
    }
    const dir = devDir ?? join(process.cwd(), 'public', devPath);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), bytes);
    return `${devPath}/${name}`;
  }
  const client = new AwsClient({
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });
  const put = await client.fetch(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${folder}/${name}`, {
    method: 'PUT',
    body: new Uint8Array(bytes),
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
  if (!put.ok) throw new Error(`R2 upload: HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return `${MEDIA_BASE}/${folder}/${name}`;
}

/** A file of the page at its head, and the head. */
async function fileAtHead(paperId: string, path: string, options: CommitOptions) {
  const database = options.database ?? getDb();
  const head = await readHead(database, paperId);
  if (!head) return { head, text: null };
  const commit = await readCommit(database, paperId, head);
  return { head, text: await readText(database, paperId, (await readFiles(database, paperId, commit.tree)).get(path)) };
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

/** Replaces the page's own links. An empty list removes the file. */
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
  const { head } = await fileAtHead(paperId, LINKS_PATH, options);
  return commitPage(
    paperId,
    head,
    actor,
    [{ path: LINKS_PATH, content: clean.length > 0 ? encodeLinksFile(clean) : null }],
    summary?.trim() || 'Change the links',
    options,
  );
}
