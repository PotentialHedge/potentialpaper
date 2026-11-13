import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import type { ThumbnailType } from './pages/rules';

/** Bytes kept outside the page repos, by hash: in R2, or in development under `public/`. */

const BUCKET = process.env.R2_BUCKET ?? 'papertrail-pdfs';
const MEDIA_BASE = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
const EXTENSIONS: Record<ThumbnailType, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

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

/**
 * Where `storeImage` puts an image with this hash and type, in R2 and in development. A pointer naming one
 * of these names an image this site stored, which it only does after reading the bytes (`card.ts`).
 */
export function imageAddresses(sha256: string, type: ThumbnailType): string[] {
  const name = `${sha256}.${EXTENSIONS[type]}`;
  return [`${MEDIA_BASE}/thumbnail/${name}`, `/thumbnails/${name}`];
}
