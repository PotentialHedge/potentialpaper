/**
 * Demos: someone's own code from a GitHub repo or gist, shown on a paper's page in an iframe. The files
 * are copied once, at a pinned commit, and served unchanged from a host of their own, never this site's.
 * Shared by the server and the browser, so nothing here touches Node.
 */

/**
 * Where demos are served. For now a host beside the app's, one path per demo (TODO.md has the move to
 * a separate domain with a subdomain per demo). Read at build time too, by `next.config.ts`.
 */
export const DEMO_ORIGIN =
  process.env.NEXT_PUBLIC_DEMO_ORIGIN ??
  (process.env.NODE_ENV === 'production' ? 'https://papers-content.potentialhedge.com' : 'http://127.0.0.1:3000');

export const DEMO_HOSTNAME = new URL(DEMO_ORIGIN).hostname;

/** Every demo's files are under this, then the snapshot's id. */
export const DEMO_PREFIX = '/d/';

/** A snapshot's id: a hash of its file list, so the same files always get the same address. */
const SNAPSHOT_ID = /^[0-9a-f]{32}$/;

export function isSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && SNAPSHOT_ID.test(value);
}

export function demoUrl(snapshot: string, path = ''): string {
  return `${DEMO_ORIGIN}${DEMO_PREFIX}${snapshot}/${path}`;
}

/**
 * The message a demo's page posts to the paper page with its content's height, so the frame fits it. The
 * demo host adds a script that sends it (`server/demos/serve.ts`); a demo may also send it itself.
 */
export const DEMO_HEIGHT_MESSAGE = 'potentialpaper:demo-height';
/** Below this a reported height is a page whose content is all fixed or absolute, which fills any frame. */
export const MIN_DEMO_HEIGHT = 120;
export const MAX_DEMO_HEIGHT = 4000;

export const MAX_DEMO_TITLE = 120;
export const MAX_DEMO_DESCRIPTION = 500;

/** One line of `community/demos.jsonl`: which files, where they came from, and what to call them. */
export interface DemoPointer {
  /** The snapshot: its files are stored by hash, and `demo_snapshots` lists them. */
  id: string;
  title: string;
  description?: string;
  /** The repo or gist, as a page to link to. */
  source: string;
  /** The commit the files were copied from. */
  commit: string;
  /** The folder in the repo that holds `index.html`, or `''` for its top. */
  root: string;
}

/** The pointer on one line of `demos.jsonl`, or `null` if it isn't one. Pages link to `source`. */
export function parseDemoPointer(value: unknown): DemoPointer | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, title, description, source, commit, root } = value as Record<string, unknown>;
  if (!isSnapshotId(id)) return null;
  if (typeof title !== 'string' || title.trim() === '' || title.length > MAX_DEMO_TITLE) return null;
  if (description !== undefined && (typeof description !== 'string' || description.length > MAX_DEMO_DESCRIPTION)) {
    return null;
  }
  if (typeof source !== 'string' || !/^https:\/\/(gist\.)?github\.com\//.test(source)) return null;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null;
  if (typeof root !== 'string' || root.startsWith('/') || root.endsWith('/') || root.includes('..')) return null;
  return { id, title, ...(description ? { description } : {}), source, commit, root };
}

/** Every pointer in a `demos.jsonl`, or `null` if any line isn't one. */
export function parseDemosFile(text: string): DemoPointer[] | null {
  const demos: DemoPointer[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    const demo = parseDemoPointer(value);
    if (!demo) return null;
    demos.push(demo);
  }
  return demos;
}

export function encodeDemosFile(demos: readonly DemoPointer[]): string {
  return demos.map((demo) => JSON.stringify(demo) + '\n').join('');
}
