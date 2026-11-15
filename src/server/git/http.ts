import { gunzipSync } from 'node:zlib';
import { getDb, type Database } from '@/db';
import { DEMO_ORIGIN } from '@/lib/demos';
import { ApiError } from '../api/errors';
import { authenticateGitPush, GIT_REALM } from '../auth';
import { answerGitRequest, findRepo, type GitAddress, parseGitAddress } from '../pages/clone';
import { lfsBatch, lfsLocks, lfsUpload } from './lfs';
import { PACK_LIMITS } from './pack-reader';
import { pageReceiveTarget } from './page-push';
import { FLUSH, pkt, PktReader } from './pkt-line';
import { receivePackAdvertisement, receivePackRequest } from './receive-pack';
import { pageRepo } from './repo';
import { advertisement, protocolVersion, uploadPackRequest } from './upload-pack';

/**
 * Git over HTTP for `app/git/[...path]/route.ts`: the smart protocol (`info/refs?service=…` and POSTs to
 * `git-upload-pack` and `git-receive-pack`), and the dumb one (`info/refs`, `HEAD`, loose objects) for
 * clients that ask for it. Everything protocol-shaped is in `upload-pack.ts` and `receive-pack.ts`; this
 * only reads requests and writes responses, and asks who is pushing (`authenticateGitPush`).
 *
 * Only loose objects may be cached, and only at the edge (DESIGN.md §4.6). Everything else changes with
 * the head, and the smart answers also carry `no-transform`, so nobody recompresses a pack.
 */

const NOT_CACHED = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
const SMART = { 'Cache-Control': 'no-store, no-transform', 'X-Robots-Tag': 'noindex, nofollow' };

/**
 * An object's id is the hash of its content, so its address never changes meaning, and the edge can keep
 * it (a Cloudflare cache rule covers `.git/objects/` addresses). Only the edge: redacting a page (DESIGN.md
 * §4.7) has to be able to purge what's kept, and nobody can purge a browser.
 */
const CACHED_OBJECT = { 'Cache-Control': 'public, max-age=0, s-maxage=31536000', 'X-Robots-Tag': 'noindex, nofollow' };

/** A fetch request is wants and haves; even a long negotiation stays far under this. */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** A push is its commands, then its pack. `proxy.ts` leaves these requests alone, so nothing buffers them first. */
export const MAX_PUSH_BYTES = PACK_LIMITS.maxPackBytes + 1024 * 1024;

function text(status: number, body: string, headers: Record<string, string> = NOT_CACHED): Response {
  return new Response(body, { status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}

const notFound = () => text(404, 'Not found\n');

export async function gitGet(req: Request, database: Database = getDb()): Promise<Response> {
  const url = new URL(req.url);
  const service = url.searchParams.get('service');
  const address = parseGitAddress(url.pathname);
  if (address?.file.startsWith('info/lfs/')) {
    return onDemoHost(req) ? notFound() : lfsLocks();
  }
  if (address?.file === 'info/refs' && service !== null) {
    if (service === 'git-receive-pack') return receivePackRefs(req, address, database);
    if (service !== 'git-upload-pack') return text(403, `Unsupported service ${service}\n`);
    const repo = await findRepo(address, database);
    if (repo.kind === 'missing') return notFound();
    if (repo.kind === 'redirect') return redirect(repo.to, url.search);
    const version = protocolVersion(req.headers.get('git-protocol'));
    const body = await advertisement(pageRepo(database, repo.paperId), version);
    // Version 2 starts with its own `version 2` line; the older ones with the service, as http-backend does.
    const prefix = version === 2 ? [] : [pkt('# service=git-upload-pack\n'), FLUSH];
    return new Response(new Uint8Array(Buffer.concat([...prefix, body])), {
      headers: { ...SMART, 'Content-Type': 'application/x-git-upload-pack-advertisement' },
    });
  }

  const answer = await answerGitRequest(url.pathname, database);
  switch (answer.kind) {
    case 'text':
      return text(200, answer.body);
    case 'object':
      return new Response(new Uint8Array(answer.body), {
        headers: { ...CACHED_OBJECT, 'Content-Type': 'application/x-git-loose-object' },
      });
    case 'redirect':
      return redirect(answer.to, url.search);
    case 'missing':
      return notFound();
  }
}

/** Git works out the new address by finding what it asked for at the end of this, query included. */
function redirect(to: string, search: string): Response {
  return new Response(null, { status: 308, headers: { ...NOT_CACHED, Location: to + search } });
}

export async function gitPost(req: Request, database: Database = getDb()): Promise<Response> {
  const url = new URL(req.url);
  const address = parseGitAddress(url.pathname);
  if (address?.file === 'git-receive-pack') return receivePack(req, address, database);
  if (address?.file.startsWith('info/lfs/')) {
    if (onDemoHost(req)) return notFound();
    if (address.file === 'info/lfs/objects/batch') return lfsBatch(req, address, database);
    if (address.file.startsWith('info/lfs/locks')) return lfsLocks();
  }
  if (address?.file !== 'git-upload-pack') {
    return text(405, 'Method not allowed\n', { ...NOT_CACHED, Allow: 'GET' });
  }
  if (req.headers.get('content-type') !== 'application/x-git-upload-pack-request') {
    return text(415, 'Expected application/x-git-upload-pack-request\n');
  }
  const body = await readBody(req, MAX_REQUEST_BYTES);
  if (!body) return text(413, 'Request too large\n');
  const repo = await findRepo(address, database);
  if (repo.kind === 'missing') return notFound();
  if (repo.kind === 'redirect') return redirect(repo.to, url.search);

  const version = protocolVersion(req.headers.get('git-protocol'));
  const output = uploadPackRequest(pageRepo(database, repo.paperId), new PktReader(body), version);
  return new Response(streamOf(output), {
    headers: { ...SMART, 'Content-Type': 'application/x-git-upload-pack-result' },
  });
}

/** The request body, gunzipped if git compressed it (it does past a kilobyte); `null` if it's too large. */
async function readBody(req: Request, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (req.body) {
    for await (const chunk of req.body) {
      size += chunk.length;
      if (size > max) return null;
      chunks.push(Buffer.from(chunk));
    }
  }
  const raw = Buffer.concat(chunks);
  const encoding = req.headers.get('content-encoding');
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    try {
      return gunzipSync(raw, { maxOutputLength: max });
    } catch {
      return null;
    }
  }
  return raw;
}

/** Pulls from the generator only as fast as the client reads, so a big pack is never held whole. */
function streamOf(output: AsyncGenerator<Buffer>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await output.next();
        if (next.done) controller.close();
        else controller.enqueue(new Uint8Array(next.value));
      } catch (err) {
        // The client has already been told (`ERR` or the error band); this is for the logs.
        console.error('git smart HTTP failed', err);
        controller.close();
      }
    },
    async cancel() {
      await output.return(undefined);
    },
  });
}

// ------------------------------------------------------------------------------------------- push

/** Not on the demo host, which `proxy.ts` would otherwise have answered (it skips pushes, see there). */
const DEMO_HOST = new URL(DEMO_ORIGIN).host;
const onDemoHost = (req: Request) => req.headers.get('host') === DEMO_HOST;

/**
 * Who is pushing, or the answer that refuses them. A 401 carries `WWW-Authenticate`, which is what makes git
 * ask for a user name and password (or its credential helper for them) and try again.
 */
async function pusher(req: Request) {
  try {
    const principal = await authenticateGitPush(req);
    return { kind: 'account', accountId: principal.account.id, isAdmin: principal.isAdmin } as const;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    const headers: Record<string, string> = { ...NOT_CACHED, ...err.headers };
    if (err.status === 401) headers['WWW-Authenticate'] = `Basic realm="${GIT_REALM}", charset="UTF-8"`;
    return text(err.status, `${err.message}\n`, headers);
  }
}

/** `GET info/refs?service=git-receive-pack`: the refs to push to, for a signed-in pusher only. */
async function receivePackRefs(req: Request, address: GitAddress, database: Database): Promise<Response> {
  if (req.headers.get('host') === DEMO_HOST) return notFound();
  const repo = await findRepo(address, database);
  if (repo.kind === 'missing') return notFound();
  if (repo.kind === 'redirect') return redirect(repo.to, new URL(req.url).search);
  const actor = await pusher(req);
  if (actor instanceof Response) return actor;
  // Git has no push in protocol v2; a client asking for it gets v0, as from git's own receive-pack.
  const version = protocolVersion(req.headers.get('git-protocol')) === 1 ? 1 : 0;
  const body = await receivePackAdvertisement(pageRepo(database, repo.paperId), version);
  return new Response(new Uint8Array(Buffer.concat([pkt('# service=git-receive-pack\n'), FLUSH, body])), {
    headers: { ...SMART, 'Content-Type': 'application/x-git-receive-pack-advertisement' },
  });
}

/** `POST git-receive-pack`: the commands and the pack, answered with the status report. */
async function receivePack(req: Request, address: GitAddress, database: Database): Promise<Response> {
  if (req.headers.get('host') === DEMO_HOST) return notFound();
  if (req.headers.get('content-type') !== 'application/x-git-receive-pack-request') {
    return text(415, 'Expected application/x-git-receive-pack-request\n');
  }
  const repo = await findRepo(address, database);
  if (repo.kind === 'missing') return notFound();
  if (repo.kind === 'redirect') return redirect(repo.to, new URL(req.url).search);
  const actor = await pusher(req);
  if (actor instanceof Response) return actor;
  const body = await readBody(req, MAX_PUSH_BYTES);
  if (!body) return text(413, `A push can be at most ${MAX_PUSH_BYTES / 1024 / 1024} MB\n`);
  const target = pageReceiveTarget(database, repo, actor);
  return new Response(streamOf(receivePackRequest(target, new PktReader(body))), {
    headers: { ...SMART, 'Content-Type': 'application/x-git-receive-pack-result' },
  });
}

/** `PUT`: only Git LFS uploads (`lfs.ts`). */
export async function gitPut(req: Request, database: Database = getDb()): Promise<Response> {
  const address = parseGitAddress(new URL(req.url).pathname);
  if (onDemoHost(req)) return notFound();
  if (!address || !/^info\/lfs\/objects\/[0-9a-f]{64}$/.test(address.file)) {
    return text(405, 'Method not allowed\n', { ...NOT_CACHED, Allow: 'GET, POST' });
  }
  return lfsUpload(req, address, database);
}
