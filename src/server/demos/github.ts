import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ApiError } from '../api/errors';
import { TarReader, type TarFile } from './tar';

/**
 * Where a demo's files come from: a public GitHub repo or gist. Only GitHub's own hosts are ever fetched,
 * and only through endpoints that need no API token and have no hourly limit: git's ref listing, and
 * codeload's tarballs.
 */

export type DemoSource =
  | { kind: 'repo'; owner: string; repo: string; /** After `/tree/`: a ref, then perhaps a folder. */ rest: string }
  | { kind: 'gist'; id: string };

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** The source a URL names, or `null` if it isn't a GitHub repo or gist. */
export function parseSourceUrl(raw: string): DemoSource | null {
  const url = URL.parse(raw.trim());
  if (!url || url.protocol !== 'https:') return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.hostname === 'gist.github.com') {
    const id = parts.at(-1);
    return id && /^[0-9a-f]{20,40}$/.test(id) && parts.length <= 2 ? { kind: 'gist', id } : null;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const [owner, rawRepo, view, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  if (view === undefined) return { kind: 'repo', owner, repo, rest: '' };
  if (view !== 'tree' && view !== 'blob') return null;
  return { kind: 'repo', owner, repo, rest: rest.join('/') };
}

export function sourcePage(source: DemoSource): string {
  return source.kind === 'gist'
    ? `https://gist.github.com/${source.id}`
    : `https://github.com/${source.owner}/${source.repo}`;
}

function gitUrl(source: DemoSource): string {
  return source.kind === 'gist'
    ? `https://gist.github.com/${source.id}.git`
    : `https://github.com/${source.owner}/${source.repo}.git`;
}

function tarballUrl(source: DemoSource, commit: string): string {
  return source.kind === 'gist'
    ? `https://codeload.github.com/gist/${source.id}/tar.gz/${commit}`
    : `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${commit}`;
}

const USER_AGENT = 'git/2.45 (potentialpaper)';
const TIMEOUT_MS = 20_000;

/** The pkt-lines of git's smart-HTTP ref advertisement, as `name → commit`, with `HEAD` among them. */
export function parseRefAdvertisement(body: string): Map<string, string> {
  const refs = new Map<string, string>();
  let at = 0;
  while (at + 4 <= body.length) {
    const length = parseInt(body.slice(at, at + 4), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      at += 4;
      continue;
    }
    const line = body.slice(at + 4, at + length).replace(/\n$/, '');
    at += length;
    const match = /^([0-9a-f]{40}) ([^\0]+)/.exec(line);
    if (match) refs.set(match[2], match[1]);
  }
  return refs;
}

async function listRefs(source: DemoSource): Promise<Map<string, string>> {
  const res = await fetch(`${gitUrl(source)}/info/refs?service=git-upload-pack`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'error',
  });
  if (res.status === 401 || res.status === 404) {
    throw new ApiError(422, 'validation_error', "that repo doesn't exist, or isn't public");
  }
  if (!res.ok) throw new ApiError(502, 'source_unavailable', `GitHub answered ${res.status}; try again`);
  return parseRefAdvertisement(await res.text());
}

/**
 * The commit and folder that `rest` names: a branch or tag (which may contain slashes, so the longest one
 * that fits wins) or a full commit id, then the folder. Nothing after `/tree/` means the default branch.
 */
export function resolveRest(
  refs: ReadonlyMap<string, string>,
  rest: string,
): { commit: string; folder: string } | null {
  if (rest === '') {
    const head = refs.get('HEAD');
    return head ? { commit: head, folder: '' } : null;
  }
  const first = rest.split('/')[0];
  if (/^[0-9a-f]{40}$/.test(first)) return { commit: first, folder: rest.slice(first.length + 1) };
  let best: { commit: string; folder: string; length: number } | null = null;
  for (const [name, commit] of refs) {
    const short = name.replace(/^refs\/(heads|tags)\//, '');
    if (short === name || short.endsWith('^{}')) continue;
    if (rest !== short && !rest.startsWith(short + '/')) continue;
    // A tag's peeled commit, when it's an annotated tag.
    const peeled = refs.get(`${name}^{}`) ?? commit;
    if (!best || short.length > best.length) {
      best = { commit: peeled, folder: rest.slice(short.length + 1), length: short.length };
    }
  }
  return best && { commit: best.commit, folder: best.folder };
}

export async function resolveCommit(source: DemoSource): Promise<{ commit: string; folder: string }> {
  const refs = await listRefs(source);
  const rest = source.kind === 'repo' ? source.rest : '';
  const resolved = resolveRest(refs, rest);
  if (!resolved) throw new ApiError(422, 'validation_error', "couldn't find that branch, tag or commit");
  return resolved;
}

/** Streamed, so this only bounds the download's time; memory holds just the files kept. */
export const MAX_TARBALL_BYTES = 1024 * 1024 * 1024;
/** What can be kept from a repo while looking for its demo: everything, when no folder is named. */
export const MAX_KEPT_BYTES = 300 * 1024 * 1024;

/** Strips the one folder GitHub puts everything in, named after the repo and commit. */
function inRepo(path: string): string | null {
  const clean = path.replace(/^(\.\/)+/, '');
  const slash = clean.indexOf('/');
  return slash === -1 || slash === clean.length - 1 ? null : clean.slice(slash + 1);
}

/**
 * The files at that commit under `folder` (all of them for `''`), with paths relative to the repo's top.
 * The tarball is unpacked as it arrives, so a large repo is fine as long as the folder is small.
 */
export async function downloadFiles(source: DemoSource, commit: string, folder = ''): Promise<TarFile[]> {
  const res = await fetch(tarballUrl(source, commit), {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(300_000),
  });
  if (res.status === 404) throw new ApiError(422, 'validation_error', "that commit isn't in the repo");
  if (!res.ok || !res.body) throw new ApiError(502, 'source_unavailable', `GitHub answered ${res.status}; try again`);

  const prefix = folder ? `${folder}/` : '';
  let kept = 0;
  const tooBig = () =>
    new ApiError(
      422,
      'validation_error',
      folder
        ? `that folder is larger than ${MAX_KEPT_BYTES / 1024 / 1024} MB`
        : 'the repo is too large to search; link the folder that has the index.html',
    );
  const reader = new TarReader((path) => {
    const inside = inRepo(path);
    return inside !== null && inside.startsWith(prefix);
  });
  const gunzip = createGunzip();
  let compressed = 0;
  const input = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  try {
    await pipeline(
      input,
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          compressed += chunk.length;
          if (compressed > MAX_TARBALL_BYTES) {
            throw new ApiError(422, 'validation_error', 'the repo is larger than 1 GB compressed');
          }
          yield chunk;
        }
      },
      gunzip,
      async function (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          const before = reader.files.length;
          reader.push(chunk);
          for (const file of reader.files.slice(before)) kept += file.bytes.length;
          if (kept > MAX_KEPT_BYTES) throw tooBig();
        }
      },
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('demo download', err);
    throw new ApiError(422, 'validation_error', "couldn't unpack the repo's files");
  }
  return reader.files.flatMap(({ path, bytes }) => {
    const inside = inRepo(path);
    return inside === null ? [] : [{ path: inside, bytes }];
  });
}
