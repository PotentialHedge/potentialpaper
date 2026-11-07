import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';

/**
 * Demo files' bytes, stored once each under their SHA-256: in R2 when its keys are set, as PDFs and
 * thumbnails are, and otherwise in a local folder, for development and tests.
 */

const BUCKET = process.env.R2_BUCKET ?? 'papertrail-pdfs';
const PUBLIC_BASE = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';

function r2(): { client: AwsClient; base: string } | null {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  return {
    client: new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      service: 's3',
      region: 'auto',
    }),
    base: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}`,
  };
}

function localDir(): string {
  if (process.env.DEMOS_DIR) return process.env.DEMOS_DIR;
  // A container's own disk is gone after the next deploy, taking every demo with it.
  if (process.env.NODE_ENV === 'production') throw new Error('demo storage: set the R2_* keys, or DEMOS_DIR');
  return join(process.cwd(), '.demos');
}

const key = (sha256: string) => `demo/${sha256}`;

export async function hasBlob(sha256: string): Promise<boolean> {
  const remote = r2();
  if (!remote) {
    return readFile(join(localDir(), sha256)).then(
      () => true,
      () => false,
    );
  }
  const res = await remote.client.fetch(`${remote.base}/${key(sha256)}`, { method: 'HEAD' });
  return res.ok;
}

export async function putBlob(sha256: string, bytes: Buffer): Promise<void> {
  const remote = r2();
  if (!remote) {
    await mkdir(localDir(), { recursive: true });
    await writeFile(join(localDir(), sha256), bytes);
    return;
  }
  const res = await remote.client.fetch(`${remote.base}/${key(sha256)}`, {
    method: 'PUT',
    body: new Uint8Array(bytes),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!res.ok) throw new Error(`R2 upload: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** The bytes, as a stream, or `null` if they aren't stored. */
export async function getBlob(sha256: string): Promise<ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | null> {
  if (!r2()) {
    return readFile(join(localDir(), sha256)).then(
      (bytes) => new Uint8Array(bytes),
      () => null,
    );
  }
  // The bucket is public, and reading through its public host lets Cloudflare cache the bytes.
  const res = await fetch(`${PUBLIC_BASE}/${key(sha256)}`);
  return res.ok ? res.body : null;
}
