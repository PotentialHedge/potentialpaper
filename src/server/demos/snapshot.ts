import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { demoSnapshots, type DemoFile } from '@/db/schema';
import { ApiError } from '../api/errors';
import { downloadFiles, parseSourceUrl, resolveCommit, sourcePage, type DemoSource } from './github';
import { hasBlob, putBlob } from './store';
import type { TarFile } from './tar';

export const MAX_DEMO_FILES = 2000;
export const MAX_DEMO_BYTES = 50 * 1024 * 1024;
export const MAX_DEMO_FILE_BYTES = 25 * 1024 * 1024;

/** Folders a built site usually ends up in, tried in this order when the URL names none. */
const BUILD_FOLDERS = ['', 'dist', 'build', 'docs', 'public', 'out', 'site', '_site', 'demo'];

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  ktx2: 'image/ktx2',
  hdr: 'image/vnd.radiance',
  exr: 'image/x-exr',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  stl: 'model/stl',
  ply: 'application/octet-stream',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
};

/** The media type a path's extension stands for, or `null` for an extension that isn't served. */
export function knownType(path: string): string | null {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  return Object.hasOwn(TYPES, ext) ? TYPES[ext] : null;
}

export function contentType(path: string): string {
  return knownType(path) ?? 'application/octet-stream';
}

/** The folder whose `index.html` is the demo: the one the URL names, or the first likely one with an index. */
export function chooseRoot(paths: ReadonlySet<string>, folder: string): string | null {
  const clean = folder.replace(/^\/+|\/+$/g, '');
  // A link to the file itself, as `/blob/main/demo/index.html` is.
  if (/(^|\/)index\.html?$/.test(clean)) return clean.replace(/\/?index\.html?$/, '');
  const candidates = clean ? [clean] : BUILD_FOLDERS;
  for (const candidate of candidates) {
    const index = candidate ? `${candidate}/index.html` : 'index.html';
    if (paths.has(index)) return candidate;
  }
  return null;
}

/** The id of a file list: the same files, under the same names, always make the same snapshot. */
export function snapshotId(files: Record<string, DemoFile>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) hash.update(`${path}\0${files[path].sha256}\n`);
  return hash.digest('hex').slice(0, 32);
}

export interface Snapshot {
  id: string;
  source: string;
  commit: string;
  root: string;
  fileCount: number;
  totalBytes: number;
}

/** Keeps the files under `root`, renamed relative to it, and checks the limits. */
export function selectFiles(all: readonly TarFile[], root: string): TarFile[] {
  const prefix = root ? `${root}/` : '';
  const files = all
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ path: file.path.slice(prefix.length), bytes: file.bytes }))
    // A built site has no need of git's own files, and they would only leak history.
    .filter((file) => !/(^|\/)\.git(\/|$)/.test(file.path));
  if (files.length > MAX_DEMO_FILES) {
    throw new ApiError(422, 'validation_error', `a demo can have at most ${MAX_DEMO_FILES} files`);
  }
  let total = 0;
  for (const file of files) {
    if (file.bytes.length > MAX_DEMO_FILE_BYTES) {
      throw new ApiError(
        422,
        'validation_error',
        `${file.path} is larger than ${MAX_DEMO_FILE_BYTES / 1024 / 1024} MB`,
      );
    }
    total += file.bytes.length;
  }
  if (total > MAX_DEMO_BYTES) {
    throw new ApiError(
      422,
      'validation_error',
      `the demo's files add up to more than ${MAX_DEMO_BYTES / 1024 / 1024} MB; point at the folder with the built site`,
    );
  }
  return files;
}

/** Copies the files of the demo at `url` into the store, and returns its snapshot. Idempotent. */
export async function snapshotDemo(url: string, database: Database = getDb()): Promise<Snapshot> {
  const source: DemoSource | null = parseSourceUrl(url);
  if (!source) {
    throw new ApiError(422, 'validation_error', 'give the address of a public GitHub repo, folder or gist');
  }
  const { commit, folder } = await resolveCommit(source);
  // A link to the index itself names its folder.
  const all = await downloadFiles(source, commit, folder.replace(/\/?index\.html?$/, '').replace(/^\/+|\/+$/g, ''));
  const root = chooseRoot(new Set(all.map((file) => file.path)), folder);
  if (root === null) {
    throw new ApiError(
      422,
      'validation_error',
      folder
        ? `there's no index.html in ${folder}`
        : `there's no index.html at the top of the repo or in ${BUILD_FOLDERS.slice(1).join(', ')}; link the folder that has it`,
    );
  }
  const files = selectFiles(all, root);

  const manifest: Record<string, DemoFile> = {};
  for (const file of files) {
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    manifest[file.path] = { sha256, bytes: file.bytes.length, type: contentType(file.path) };
  }
  const id = snapshotId(manifest);
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const snapshot = { id, source: sourcePage(source), commit, root, fileCount: files.length, totalBytes };

  const [known] = await database.select({ id: demoSnapshots.id }).from(demoSnapshots).where(eq(demoSnapshots.id, id));
  if (known) return snapshot;

  // Bytes first, so a snapshot row never names a file that isn't stored.
  const queue = [...files];
  const upload = async () => {
    for (let file = queue.pop(); file; file = queue.pop()) {
      const { sha256 } = manifest[file.path];
      if (!(await hasBlob(sha256))) await putBlob(sha256, file.bytes);
    }
  };
  await Promise.all(Array.from({ length: 8 }, upload));
  await database
    .insert(demoSnapshots)
    .values({ id, source: snapshot.source, commit, root, files: manifest, totalBytes })
    .onConflictDoNothing();
  return snapshot;
}
