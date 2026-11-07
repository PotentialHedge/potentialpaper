import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AwsClient } from 'aws4fetch';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts, user } from '@/db/schema';
import { parsePaperId, PAPER_SCHEMES, type PaperScheme } from '@/lib/paper-ids';
import { isAdminEmail } from '@/server/auth';
import { commitPage, type Actor } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import {
  imageType,
  MAX_THUMBNAIL_BYTES,
  parseThumbnailPointer,
  THUMBNAIL_PATH,
  type ThumbnailPointer,
} from '@/server/pages/rules';
import { findPaper } from '@/server/papers';

const USAGE = `Set a paper's thumbnail, shown in place of its PDF's first page, until authors can upload one.

  npm run pages:set-thumbnail -- openreview:j6wn1MIOB5 ./teaser.gif --as <admin handle> [--alt "..."] [--caption "..."]
  npm run pages:set-thumbnail -- openreview:j6wn1MIOB5 --remove --as <admin handle>

JPEG, PNG, GIF (animated too), WebP or AVIF, up to ${MAX_THUMBNAIL_BYTES / 1024 / 1024} MB. The bytes go to R2
under their SHA-256 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY), and the page's
${THUMBNAIL_PATH} points at them. In development, THUMBNAILS_DIR=public/thumbnails writes them there instead.`;

const BUCKET = process.env.R2_BUCKET ?? 'papertrail-pdfs';
const MEDIA_BASE = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
const LOCAL_DIR = process.env.THUMBNAILS_DIR;
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (or set THUMBNAILS_DIR to write thumbnails locally)`);
  return value;
}

/** Stores the bytes under their hash, and returns their address. */
async function store(bytes: Buffer, sha256: string, type: ThumbnailPointer['type']): Promise<string> {
  const name = `${sha256}.${EXTENSIONS[type]}`;
  if (LOCAL_DIR) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    writeFileSync(join(LOCAL_DIR, name), bytes);
    return `/thumbnails/${name}`;
  }
  const client = new AwsClient({
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    service: 's3',
    region: 'auto',
  });
  const put = await client.fetch(
    `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${BUCKET}/thumbnail/${name}`,
    {
      method: 'PUT',
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' },
    },
  );
  if (!put.ok) throw new Error(`upload: HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return `${MEDIA_BASE}/thumbnail/${name}`;
}

async function adminActor(handle: string): Promise<Actor> {
  const [row] = await getDb()
    .select({ id: accounts.id, email: user.email })
    .from(accounts)
    .leftJoin(user, eq(user.id, accounts.userId))
    .where(eq(accounts.handle, handle.toLowerCase()));
  if (!row) throw new Error(`no account with the handle ${handle}`);
  return { kind: 'account', accountId: row.id, isAdmin: row.email ? isAdminEmail(row.email) : false };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      as: { type: 'string' },
      alt: { type: 'string' },
      caption: { type: 'string' },
      remove: { type: 'boolean' },
    },
  });
  const [target, file] = positionals;
  const [schemeText, ...rest] = (target ?? '').split(':');
  const scheme = PAPER_SCHEMES.find((s): s is PaperScheme => s === schemeText);
  const id = scheme && parsePaperId(scheme, rest.join(':'));
  if (!id || !values.as || (!file && !values.remove)) {
    console.error(USAGE);
    process.exit(2);
  }
  const found = await findPaper(id);
  if (!found) throw new Error(`no paper ${target} in this database`);
  const actor = await adminActor(values.as);
  const paperId = found.paper.id;

  let content: string | null = null;
  if (!values.remove) {
    const bytes = readFileSync(file!);
    const type = imageType(bytes);
    if (!type) throw new Error(`${file} is not a JPEG, PNG, GIF, WebP or AVIF image`);
    if (bytes.length > MAX_THUMBNAIL_BYTES) throw new Error(`${file} is larger than ${MAX_THUMBNAIL_BYTES} bytes`);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const url = await store(bytes, sha256, type);
    const pointer: ThumbnailPointer = {
      sha256,
      bytes: bytes.length,
      type,
      url,
      ...(values.alt ? { alt: values.alt } : {}),
      ...(values.caption ? { caption: values.caption } : {}),
    };
    content = `${JSON.stringify(pointer, null, 2)}\n`;
    if (!parseThumbnailPointer(content)) throw new Error('the pointer is not valid');
  }
  const result = await commitPage(
    paperId,
    await readHead(getDb(), paperId),
    actor,
    [{ path: THUMBNAIL_PATH, content }],
    values.remove ? 'Remove the thumbnail' : 'Set the thumbnail',
  );
  console.log(JSON.stringify(result));
  await getPool().end();
}

main().catch((err) => {
  console.error(err.message ?? err, err.details ? JSON.stringify(err.details, null, 2) : '');
  process.exit(1);
});
