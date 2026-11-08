/**
 * Demos: someone's own code from a GitHub repo or gist, shown on a paper's page in an iframe. The files
 * are copied once, at a pinned commit, and served unchanged from a host of their own, never this site's.
 * A page's Markdown embeds one with a ```` ```demo ```` block, in either section. Shared by the server and
 * the browser, so nothing here touches Node.
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

/** What a frame running a demo may do: run scripts, keep its own storage, and take the pointer, the screen and a headset. */
export const DEMO_SANDBOX =
  'allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms allow-downloads';
export const DEMO_ALLOW =
  'fullscreen; xr-spatial-tracking; gamepad; autoplay; accelerometer; gyroscope; clipboard-write';

/** Where a snapshot's files came from (`demo_snapshots`): enough to link to them on GitHub. */
export interface DemoSource {
  id: string;
  /** The repo or gist, as a page to link to. */
  source: string;
  /** The commit the files were copied from. */
  commit: string;
  /** The folder in the repo that holds `index.html`, or `''` for its top. */
  root: string;
}

/**
 * A demo in a page's Markdown:
 *
 *     ```demo 0123456789abcdef0123456789abcdef
 *     Its title
 *     What it shows, optionally, on the lines after.
 *     ```
 */
export interface DemoBlock {
  id: string;
  title: string;
  description?: string;
}

const DEMO_INFO = /^demo\s+([0-9a-f]{32})$/;

/** The snapshot a fence's info string names, if it is a demo block's. */
export function demoBlockId(info: string): string | null {
  return DEMO_INFO.exec(info.trim())?.[1] ?? null;
}

/** A demo block's title and description, from its body: the first line, then the rest. */
export function demoBlockText(body: string): { title: string; description?: string } {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const title = (lines[0] ?? '').slice(0, MAX_DEMO_TITLE);
  const description = lines.slice(1).join(' ').slice(0, MAX_DEMO_DESCRIPTION);
  return { title, ...(description ? { description } : {}) };
}

/** The Markdown for a demo, as the editor inserts it. */
export function demoBlockMarkdown({ id, title, description }: DemoBlock): string {
  const line = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').replaceAll('`', "'").trim();
  return ['```demo ' + id, line(title), line(description), '```'].filter(Boolean).join('\n').concat('\n');
}

/** The files' own page on GitHub, at the commit they were copied from. */
export function sourceAt(demo: DemoSource): string {
  if (demo.source.startsWith('https://gist.github.com/')) return `${demo.source}/${demo.commit}`;
  return `${demo.source}/tree/${demo.commit}${demo.root ? `/${demo.root}` : ''}`;
}

export function sourceLabel(demo: DemoSource): string {
  const name = demo.source.replace(/^https:\/\/(gist\.)?github\.com\//, '');
  return `${name}${demo.root ? `/${demo.root}` : ''}@${demo.commit.slice(0, 7)}`;
}
