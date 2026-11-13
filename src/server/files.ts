import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { evidenceFiles, pdfDocuments, type EvidenceFile } from '@/db/schema';
import { AGENT_FILE_TEXT_TYPES } from '@/lib/agent-posts';
import type { VersionPdf } from '@/lib/versions';
import { ApiError } from './api/errors';
import { storeMedia } from './pages/card';
import { imageType } from './pages/rules';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';

/**
 * Files people and agents upload to back up an edit (a decision letter, a screenshot of a proceedings
 * page), and PDFs of a paper's versions (`lib/versions.ts`). The bytes are public in R2 under their hash as
 * soon as they are stored, so only verified accounts may upload, and `evidence_files` records who did.
 *
 * A PDF is stored where the page PDFs are (`pdf/<sha256>.pdf`), and gets a `pdf_documents` row, so the
 * ingest pipeline extracts its text, which is what comparing two versions diffs.
 */

const UPLOAD_BUDGET: RateLimitConfig = { burst: 40, perSecond: 40 / 3600 };
export const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/**
 * Where the server will fetch a PDF from for someone, instead of their uploading it: the open archives and
 * proceedings papers are on. Fetching any address would let a request reach inside our network.
 */
export const FETCHABLE_HOSTS = [
  'openreview.net',
  'arxiv.org',
  'export.arxiv.org',
  'aclanthology.org',
  'proceedings.mlr.press',
  'papers.nips.cc',
  'proceedings.neurips.cc',
  'openaccess.thecvf.com',
  'www.ijcai.org',
  'ojs.aaai.org',
  'jmlr.org',
  'www.jmlr.org',
];

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

function isPdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes('%PDF-');
}

/** A file's name as given, made safe to show and to put in a URL path. */
function cleanName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    .normalize('NFKC')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return clean || fallback;
}

/** What the bytes are, or why they can't be evidence. Nothing a browser would run (HTML, SVG) is taken. */
function classify(bytes: Buffer, name: string): { type: string; ext: string } {
  if (isPdf(bytes)) {
    if (bytes.length > MAX_PDF_BYTES) {
      throw new ApiError(422, 'validation_error', `a PDF may be at most ${MAX_PDF_BYTES / 1024 / 1024} MB`);
    }
    return { type: 'application/pdf', ext: 'pdf' };
  }
  const image = imageType(bytes);
  if (image) {
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new ApiError(422, 'validation_error', `an image may be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    }
    return { type: image, ext: IMAGE_EXTENSIONS[image] };
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const type = (AGENT_FILE_TEXT_TYPES as Record<string, string>)[ext];
  if (!type) {
    throw new ApiError(
      422,
      'validation_error',
      `send a PDF, an image (PNG, JPEG, GIF, WebP, AVIF) or a text file named .${Object.keys(AGENT_FILE_TEXT_TYPES).join(', .')}`,
    );
  }
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new ApiError(422, 'validation_error', `a text file may be at most ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(422, 'validation_error', 'a text file has to be UTF-8');
  }
  return { type, ext };
}

async function spend(accountId: string | null): Promise<void> {
  if (!accountId) return;
  const budget = await consume(`evidence-file:${accountId}`, UPLOAD_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many uploads from this account; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
}

/**
 * Stores a file and records who stored it. `accountId` is `null` for the system (imports). A PDF also gets a
 * `pdf_documents` row, for ingest.
 */
export async function storeFile(
  accountId: string | null,
  bytes: Buffer,
  givenName: string,
  options: { source?: string; database?: Database; counted?: boolean } = {},
): Promise<EvidenceFile> {
  const database = options.database ?? getDb();
  if (bytes.length === 0) throw new ApiError(422, 'validation_error', 'the file is empty');
  const { type, ext } = classify(bytes, givenName);
  if (!options.counted) await spend(accountId);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const name = cleanName(givenName, `${sha256.slice(0, 12)}.${ext}`);
  const pdf = type === 'application/pdf';
  // Text is served as what it is, but never as something a browser would render as a page.
  const contentType = pdf || type.startsWith('image/') ? type : `${type}; charset=utf-8`;
  const url = await storeMedia(bytes, pdf ? `${sha256}.pdf` : `${sha256}-${name}`, contentType, {
    folder: pdf ? 'pdf' : 'evidence',
    devDir: process.env.EVIDENCE_FILES_DIR,
    devPath: '/files',
  });
  if (pdf) {
    await database.insert(pdfDocuments).values({ sha256, url, bytes: bytes.length }).onConflictDoNothing();
  }
  const [file] = await database
    .insert(evidenceFiles)
    .values({ accountId, sha256, type, name, bytes: bytes.length, url, source: options.source ?? null })
    .returning();
  return file;
}

function fetchable(url: URL): boolean {
  return url.protocol === 'https:' && FETCHABLE_HOSTS.includes(url.hostname);
}

/** Downloads at most `max` bytes, following redirects only to hosts we fetch from. */
async function download(address: string, max: number): Promise<Buffer> {
  let url = URL.parse(address);
  for (let hop = 0; hop < 4; hop += 1) {
    if (!url || !fetchable(url)) {
      throw new ApiError(
        422,
        'validation_error',
        `we can copy a PDF from ${FETCHABLE_HOSTS.filter((h) => !h.startsWith('www.')).join(', ')}; upload it otherwise`,
      );
    }
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
      headers: { 'User-Agent': 'PotentialPaper (+https://papers.potentialhedge.com)' },
    });
    if (res.status >= 300 && res.status < 400) {
      url = URL.parse(res.headers.get('location') ?? '', url);
      continue;
    }
    if (!res.ok || !res.body) throw new ApiError(422, 'validation_error', `${url.hostname} answered ${res.status}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new ApiError(422, 'validation_error', `the file is larger than ${max / 1024 / 1024} MB`);
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new ApiError(422, 'validation_error', 'too many redirects');
}

/** Copies a PDF from an archive or proceedings site, for a version. */
export async function fetchPdf(
  accountId: string | null,
  address: string,
  database: Database = getDb(),
): Promise<EvidenceFile> {
  await spend(accountId);
  const bytes = await download(address, MAX_PDF_BYTES);
  if (!isPdf(bytes)) throw new ApiError(422, 'validation_error', 'that address is not a PDF');
  return storeFile(accountId, bytes, 'paper.pdf', { source: address, database, counted: true });
}

/**
 * A version's PDF from the address the editor sends: one of ours, which has to be a PDF uploaded or copied
 * here, so the pointer's hash is ours to vouch for.
 */
export async function versionPdfAt(url: string, database: Database = getDb()): Promise<VersionPdf> {
  // Uploaded or copied here, or a PDF a page already points at.
  const { rows } = await database.execute<{ sha256: string; bytes: number; url: string; source: string | null }>(sql`
    (select sha256, bytes, url, source from evidence_files
      where url = ${url} and type = 'application/pdf' order by created_at limit 1)
    union all
    (select sha256, bytes, url, null from pdf_documents where url = ${url} and bytes is not null limit 1)
    union all
    -- A page's own PDF, before the ingest has read its size.
    (select pdf->>'sha256', (pdf->>'bytes')::bigint, pdf->>'url', pdf->>'source' from page_current
      where pdf->>'url' = ${url} and pdf->>'bytes' is not null limit 1)
    limit 1
  `);
  const row = rows[0];
  if (!row) {
    throw new ApiError(
      422,
      'validation_error',
      'a version’s PDF has to be uploaded or copied here first (/api/v1/files)',
    );
  }
  return { sha256: row.sha256, bytes: Number(row.bytes), url: row.url, ...(row.source ? { source: row.source } : {}) };
}
