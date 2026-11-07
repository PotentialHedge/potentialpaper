import 'dotenv/config';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AwsClient } from 'aws4fetch';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { pdfCovers } from '@/db/schema';
import type { ManifestRow } from './upload-pdfs';

/**
 * Renders the first page of every hosted PDF that has no cover yet to a small JPEG, puts it in R2 beside
 * the PDF (`cover/<sha256>.jpg`), and records it in `pdf_covers` for search results. Needs poppler's
 * `pdftoppm`. Safe to stop and run again: a cover already in R2 is recorded without rendering it again.
 *
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… npm run papers:render-covers
 *
 * Where the scrape's PDFs are on disk, `-- <manifest> <pdf dir>` (as given to `upload-pdfs`) reads them
 * there instead of downloading them again; a PDF not found there, or whose bytes differ, is downloaded.
 * `COVERS_NO_DB=1` then renders and uploads every PDF in the manifest without touching a database, so
 * covers can be made before the table exists; a later run with the database only records them.
 *
 * In development, `COVERS_DIR=public/covers` writes the files there instead, served at `/covers/…`.
 */
const BUCKET = process.env.R2_BUCKET ?? 'papertrail-pdfs';
const PDF_BASE = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
const LOCAL_DIR = process.env.COVERS_DIR;
const NO_DB = process.env.COVERS_NO_DB === '1';
const WORKERS = Number(process.env.COVER_WORKERS ?? 8);
/** The longer side, in pixels: about three times what a result shows, for sharp text on a dense screen. */
const SIZE = 360;
const ATTEMPTS = 4;

const run = promisify(execFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (or set COVERS_DIR to write covers locally)`);
  return value;
}

interface Store {
  /** The cover's address if it is already stored, else `null`. */
  existing(sha256: string): Promise<string | null>;
  /** Stores a cover, and returns its address. */
  put(sha256: string, jpeg: Buffer): Promise<string>;
}

function store(): Store {
  if (LOCAL_DIR) {
    mkdirSync(LOCAL_DIR, { recursive: true });
    const path = (sha256: string) => join(LOCAL_DIR, `${sha256}.jpg`);
    const url = (sha256: string) => `/covers/${sha256}.jpg`;
    return {
      existing: async (sha256) => (existsSync(path(sha256)) ? url(sha256) : null),
      put: async (sha256, jpeg) => {
        writeFileSync(path(sha256), jpeg);
        return url(sha256);
      },
    };
  }
  const client = new AwsClient({
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    service: 's3',
    region: 'auto',
  });
  const base = `https://${required('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/${BUCKET}`;
  const url = (sha256: string) => `${PDF_BASE}/cover/${sha256}.jpg`;
  return {
    existing: async (sha256) => {
      const head = await client.fetch(`${base}/cover/${sha256}.jpg`, { method: 'HEAD' });
      if (head.status === 404) return null;
      if (!head.ok) throw new Error(`HEAD cover: HTTP ${head.status}`);
      return url(sha256);
    },
    put: async (sha256, jpeg) => {
      const put = await client.fetch(`${base}/cover/${sha256}.jpg`, {
        method: 'PUT',
        body: new Uint8Array(jpeg),
        headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
      });
      if (!put.ok) throw new Error(`HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
      return url(sha256);
    },
  };
}

/** Page 1 as a progressive JPEG, its longer side `SIZE`. */
async function render(pdf: Buffer): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'cover-'));
  try {
    writeFileSync(join(dir, 'in.pdf'), pdf);
    await run(
      'pdftoppm',
      [
        '-f',
        '1',
        '-l',
        '1',
        '-singlefile',
        '-scale-to',
        String(SIZE),
        '-jpeg',
        '-jpegopt',
        'quality=72,progressive=y,optimize=y',
        'in.pdf',
        'out',
      ],
      { cwd: dir, timeout: 60_000 },
    );
    return readFileSync(join(dir, 'out.jpg'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readManifest(manifest: string | undefined): ManifestRow[] {
  if (!manifest) return [];
  return readFileSync(manifest, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ManifestRow);
}

async function readPdf(sha256: string, url: string, path: string | undefined): Promise<Buffer> {
  if (path && existsSync(path)) {
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') === sha256) return bytes;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The PDFs without a recorded cover, or with `COVERS_NO_DB`, every PDF in the manifest. */
async function pending(rows: ManifestRow[]): Promise<{ sha256: string; url: string }[]> {
  if (NO_DB) {
    if (rows.length === 0) throw new Error('COVERS_NO_DB needs a manifest');
    const seen = new Set<string>();
    return rows
      .filter((row) => !seen.has(row.sha256) && seen.add(row.sha256))
      .map((row) => ({ sha256: row.sha256, url: `${PDF_BASE}/pdf/${row.sha256}.pdf` }));
  }
  const { rows: queue } = await getDb().execute<{ sha256: string; url: string }>(sql`
    select distinct on (c.pdf ->> 'sha256') c.pdf ->> 'sha256' as sha256, c.pdf ->> 'url' as url
    from page_current c
    where c.pdf is not null
      and not exists (select from pdf_covers pc where pc.sha256 = c.pdf ->> 'sha256')
  `);
  return queue;
}

async function main() {
  const [manifest, dir] = process.argv.slice(2);
  const rows = readManifest(manifest);
  const local = new Map(dir ? rows.map((row) => [row.sha256, join(dir, `${row.id}.pdf`)]) : []);
  const covers = store();
  const queue = await pending(rows);
  console.log(
    `${queue.length} PDFs without a cover, ${queue.filter((q) => local.has(q.sha256)).length} of them on disk`,
  );

  let rendered = 0;
  let found = 0;
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      while (next < queue.length) {
        const { sha256, url } = queue[next++];
        for (let attempt = 1; ; attempt += 1) {
          try {
            let coverUrl = await covers.existing(sha256);
            if (coverUrl) found += 1;
            else {
              coverUrl = await covers.put(sha256, await render(await readPdf(sha256, url, local.get(sha256))));
              rendered += 1;
            }
            if (!NO_DB) {
              await getDb()
                .insert(pdfCovers)
                .values({ sha256, url: coverUrl })
                .onConflictDoUpdate({ target: pdfCovers.sha256, set: { url: coverUrl } });
            }
            const done = rendered + found;
            if (done % 500 === 0) console.log(`${done}/${queue.length}, ${rendered} rendered, ${failed} failed`);
            break;
          } catch (err) {
            if (attempt === ATTEMPTS) {
              failed += 1;
              console.error(`${sha256}: ${String(err)}`);
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
          }
        }
      }
    }),
  );
  console.log(`rendered ${rendered}, already stored ${found}, failed ${failed}`);
  if (!NO_DB) await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
