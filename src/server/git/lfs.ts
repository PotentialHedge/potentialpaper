import { createHash } from 'node:crypto';
import { getDb, type Database } from '@/db';
import { ApiError } from '../api/errors';
import { authenticateGitPush, GIT_REALM } from '../auth';
import { storeLfsUpload } from '../files';
import { findLfsObjects } from '../lfs';
import { checkPaper } from '../pages/check';
import { clonePath, findRepo, type GitAddress } from '../pages/clone';
import { MAX_LFS_PDF_BYTES } from '../pages/rules';
import { siteUrl } from '../site';

/**
 * Git LFS over HTTPS (https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md), which is how a page's
 * PDFs and picture move: the repo has pointers (`rules.ts`), and `git lfs` asks here where the bytes are.
 * Its address is the clone address's `info/lfs/`, which `git lfs` finds by itself.
 *
 * - **Download** is anyone's, as a clone is: each object's action is its public address in R2.
 * - **Upload** is for whoever may push (an API key as the password, `authenticateGitPush`): the action is a
 *   `PUT` back here, which reads the bytes, checks their hash, and stores them only if they are a PDF or a
 *   picture (`storeLfsUpload`). Then a pushed pointer may name them (`check.ts`). `git lfs` uploads before
 *   it pushes, so a push never waits on this.
 * - **Locks:** pages have none, but `git lfs` asks before a push, so it is told so in the way that keeps it quiet.
 */

const LFS_TYPE = 'application/vnd.git-lfs+json';
const HEADERS = { 'Content-Type': LFS_TYPE, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
/** `git lfs` asks for at most 100 at a time. */
const MAX_BATCH = 1000;
const MAX_BATCH_BYTES = 1024 * 1024;
const OID = /^[0-9a-f]{64}$/;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...headers } });
}

/** An error as `git lfs` shows it: the `message`, after "batch response:" or the like. */
function failure(status: number, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { message }, headers);
}

function fromApiError(err: unknown): Response {
  if (!(err instanceof ApiError)) throw err;
  const headers: Record<string, string> = { ...err.headers };
  // What makes `git lfs` ask git's credential helper for the API key, as a push does.
  if (err.status === 401) headers['WWW-Authenticate'] = `Basic realm="${GIT_REALM}", charset="UTF-8"`;
  return failure(err.status, err.message, headers);
}

/** The page the address names, or the answer to give instead. */
async function repoOf(address: GitAddress, database: Database) {
  const repo = await findRepo(address, database);
  if (repo.kind === 'missing') return failure(404, 'no such page');
  if (repo.kind === 'redirect') {
    return new Response(null, { status: 307, headers: { ...HEADERS, Location: repo.to } });
  }
  return repo;
}

async function readLimited(req: Request, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.length;
      if (size > max) return null;
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

/** A path on this site in development, absolute; `git lfs` needs an absolute address. */
const absolute = (url: string) => (url.startsWith('/') ? `${siteUrl()}${url}` : url);

interface BatchObject {
  oid: string;
  size: number;
}

function parseBatch(body: Buffer): { operation: 'download' | 'upload'; objects: BatchObject[] } | string {
  let value: { operation?: unknown; objects?: unknown; transfers?: unknown; hash_algo?: unknown };
  try {
    value = JSON.parse(body.toString('utf8')) as typeof value;
  } catch {
    return 'the request is not JSON';
  }
  if (value === null || typeof value !== 'object') return 'the request is not a JSON object';
  if (value.operation !== 'download' && value.operation !== 'upload') return 'operation is download or upload';
  if (value.hash_algo !== undefined && value.hash_algo !== 'sha256') return 'only sha256';
  if (Array.isArray(value.transfers) && !value.transfers.includes('basic')) return 'only the basic transfer';
  if (!Array.isArray(value.objects) || value.objects.length > MAX_BATCH)
    return `objects is a list of up to ${MAX_BATCH}`;
  const objects: BatchObject[] = [];
  for (const item of value.objects as { oid?: unknown; size?: unknown }[]) {
    if (typeof item?.oid !== 'string' || !OID.test(item.oid)) return 'an object needs a sha256 oid';
    if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0) {
      return 'an object needs a size';
    }
    objects.push({ oid: item.oid, size: item.size });
  }
  return { operation: value.operation, objects };
}

/** `POST info/lfs/objects/batch`: where to download each object from, or where to upload it to. */
export async function lfsBatch(req: Request, address: GitAddress, database: Database = getDb()): Promise<Response> {
  const body = await readLimited(req, MAX_BATCH_BYTES);
  if (!body) return failure(413, 'the request is too large');
  const batch = parseBatch(body);
  if (typeof batch === 'string') return failure(422, batch);
  const repo = await repoOf(address, database);
  if (repo instanceof Response) return repo;
  const known = await findLfsObjects(
    database,
    batch.objects.map((o) => o.oid),
  );

  if (batch.operation === 'download') {
    const objects = batch.objects.map(({ oid, size }) => {
      const object = known.get(oid);
      if (!object || object.bytes !== size) return { oid, size, error: { code: 404, message: 'no such file here' } };
      return {
        oid,
        size,
        authenticated: true,
        actions: { download: { href: absolute(object.url), expires_in: 86400 } },
      };
    });
    return json(200, { transfer: 'basic', objects, hash_algo: 'sha256' });
  }

  try {
    await authenticateGitPush(req);
    await checkPaper(database, repo.paperId);
  } catch (err) {
    return fromApiError(err);
  }
  const href = (oid: string) => `${siteUrl()}${clonePath(address.id, `/info/lfs/objects/${oid}`)}`;
  const objects = batch.objects.map(({ oid, size }) => {
    const object = known.get(oid);
    // Already here: nothing to send.
    if (object && object.bytes === size) return { oid, size, authenticated: true };
    if (size === 0 || size > MAX_LFS_PDF_BYTES) {
      return {
        oid,
        size,
        error: { code: 422, message: `a file has to be 1 byte to ${MAX_LFS_PDF_BYTES / 1024 / 1024} MB` },
      };
    }
    return {
      oid,
      size,
      authenticated: true,
      // The same key again: the PUT is to this site, and is checked as the batch was.
      actions: {
        upload: {
          href: href(oid),
          header: { Authorization: req.headers.get('authorization') ?? '' },
          expires_in: 3600,
        },
      },
    };
  });
  return json(200, { transfer: 'basic', objects, hash_algo: 'sha256' });
}

/** `PUT info/lfs/objects/<oid>`: the bytes of one object, stored if they are a PDF or a picture. */
export async function lfsUpload(req: Request, address: GitAddress, database: Database = getDb()): Promise<Response> {
  const oid = address.file.slice('info/lfs/objects/'.length);
  const repo = await repoOf(address, database);
  if (repo instanceof Response) return repo;
  let accountId: string;
  try {
    accountId = (await authenticateGitPush(req)).account.id;
    await checkPaper(database, repo.paperId);
  } catch (err) {
    return fromApiError(err);
  }
  if ((await findLfsObjects(database, [oid])).has(oid)) return new Response(null, { status: 200, headers: HEADERS });
  const bytes = await readLimited(req, MAX_LFS_PDF_BYTES);
  if (!bytes) return failure(413, `a file can be at most ${MAX_LFS_PDF_BYTES / 1024 / 1024} MB`);
  if (createHash('sha256').update(bytes).digest('hex') !== oid) {
    return failure(422, 'the bytes do not have the sha256 they were sent as');
  }
  try {
    await storeLfsUpload(accountId, bytes, database);
  } catch (err) {
    return fromApiError(err);
  }
  return new Response(null, { status: 200, headers: HEADERS });
}

/**
 * `info/lfs/locks…`: pages have no locks. `git lfs` asks before each push, and a 501 is what makes it stop
 * asking for that clone without a word (it sets `lfs.<url>.locksverify false`); any answer else prints a hint.
 */
export async function lfsLocks(): Promise<Response> {
  return failure(501, 'files of a page cannot be locked');
}
