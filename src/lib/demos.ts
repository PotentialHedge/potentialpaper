/**
 * Demos: someone's own code, shown on a paper's page in an iframe. The files are copied once, from a GitHub
 * repo or gist at a pinned commit or from the page's own repo, and served unchanged from a host of their own,
 * never this site's. A page's Markdown embeds one with a ```` ```demo ```` block, in either section. Shared by
 * the server and the browser, so nothing here touches Node.
 */

/**
 * Where user content is served: a domain of its own, never a site the app's cookies or pages share, with a host
 * per demo (`<snapshot>.<domain>`) and per web editor webview (`<uuid>.<domain>`, `editors/vscode/csp.ts`), so
 * none can reach another's storage. Nothing is served at the domain itself. In development, `*.localhost`, which
 * browsers resolve to the machine. Read at build time too, by `next.config.ts`.
 */
export const CONTENT_ORIGIN =
  process.env.NEXT_PUBLIC_CONTENT_ORIGIN ??
  (process.env.NODE_ENV === 'production' ? 'https://ppusercontent.com' : 'http://localhost:3000');

const content = new URL(CONTENT_ORIGIN);

export const CONTENT_HOSTNAME = content.hostname;

/** Every host under the content domain, as a CSP source. */
export const CONTENT_SOURCE = `${content.protocol}//*.${content.host}`;

/** A snapshot's id: a hash of its file list, so the same files always get the same address. */
const SNAPSHOT_ID = /^[0-9a-f]{32}$/;

export function isSnapshotId(value: unknown): value is string {
  return typeof value === 'string' && SNAPSHOT_ID.test(value);
}

/** A host name under the content domain (not the domain itself), which only user content is served from. */
export function isContentHost(hostname: string): boolean {
  return hostname.endsWith(`.${CONTENT_HOSTNAME}`);
}

/** The snapshot a demo's host name serves, or `null`: a webview's, or not on the content domain. */
export function demoOfHost(hostname: string): string | null {
  if (!isContentHost(hostname)) return null;
  const label = hostname.slice(0, -CONTENT_HOSTNAME.length - 1);
  return isSnapshotId(label) ? label : null;
}

/** The content domain's host names, as a regular expression for `next.config.ts`'s `has`/`missing` (matched whole). */
export const CONTENT_HOST_PATTERN = `.+\\.${CONTENT_HOSTNAME.replaceAll('.', '\\.')}`;

export function demoOrigin(snapshot: string): string {
  return `${content.protocol}//${snapshot}.${content.host}`;
}

export function demoUrl(snapshot: string, path = ''): string {
  return `${demoOrigin(snapshot)}/${path}`;
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

/** Where a snapshot's files came from (`demo_snapshots`): enough to link to them. */
export interface DemoSource {
  id: string;
  /** The repo or gist, as a page to link to; or `page:<paper id>` for a folder of the page's own repo. */
  source: string;
  /** The commit the files were copied from: GitHub's, or the page's. */
  commit: string;
  /** The folder that holds `index.html`, or `''` for the repo's top. */
  root: string;
}

/** The `source` of a snapshot made from a page's own `demos/<name>/` (`server/demos/repo.ts`). */
export const PAGE_SOURCE_PREFIX = 'page:';

/**
 * A demo in a page's Markdown. The fence names the demo, then the title is its first line and an optional
 * description follows:
 *
 *     ```demo https://github.com/you/demo/tree/main/dist
 *     Its title
 *     What it shows, optionally, on the lines after.
 *     ```
 *
 * The name is one of
 *
 * - a GitHub address, as GitHub prints it: `https://github.com/<owner>/<repo>`, optionally followed by
 *   `/tree/<branch, tag or commit>/<folder>` (or `/blob/…/index.html`), or a gist's. The server copies the
 *   files when the commit that adds the block comes in, and keeps that copy for as long as the block stays
 *   on the page (`demo_pins`); the file keeps the address as it was written.
 * - `demos/<name>`: a folder of the page's own repo, with an `index.html`.
 * - a snapshot's id, as the editor's "Insert a demo" writes it.
 */
export type DemoRef =
  { kind: 'snapshot'; id: string } | { kind: 'github'; url: string } | { kind: 'repo'; name: string };

export interface DemoBlock {
  ref: DemoRef;
  title: string;
  description?: string;
}

/** A demo folder's name in a page repo: a lower-case slug, as a section's is. */
export const DEMO_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_DEMO_NAME = 60;
export const DEMOS_DIR = 'demos';

const GITHUB_ADDRESS = /^https:\/\/(www\.|gist\.)?github\.com\/\S+$/;

/**
 * What a fence's info string names: `null` if it isn't a demo block at all, a `problem` if it starts with
 * `demo` but names nothing a demo can be.
 */
export function parseDemoInfo(info: string): DemoRef | { problem: string } | null {
  const [word, name, ...rest] = info.trim().split(/\s+/);
  if (word !== 'demo') return null;
  if (!name || rest.length > 0) {
    return { problem: 'a demo block names one demo after ```demo: a GitHub address, demos/<name> or a snapshot id' };
  }
  if (SNAPSHOT_ID.test(name)) return { kind: 'snapshot', id: name };
  if (GITHUB_ADDRESS.test(name)) return { kind: 'github', url: name };
  const folder = /^demos\/([^/]+)\/?$/.exec(name);
  if (folder) {
    return DEMO_NAME.test(folder[1]) && folder[1].length <= MAX_DEMO_NAME
      ? { kind: 'repo', name: folder[1] }
      : { problem: `${name}: a demo folder is named like demos/my-demo (lower-case letters, digits and dashes)` };
  }
  return { problem: `${name} is not a demo: give a GitHub address, demos/<name> or a snapshot id` };
}

/** The demo a fence names, or `null` if it names none. */
export function demoBlockRef(info: string): DemoRef | null {
  const parsed = parseDemoInfo(info);
  return parsed && !('problem' in parsed) ? parsed : null;
}

/** One key per demo a page can name, for looking up its source: the id, the address, or `demos/<name>`. */
export function demoRefKey(ref: DemoRef): string {
  return ref.kind === 'snapshot' ? ref.id : ref.kind === 'github' ? ref.url : `${DEMOS_DIR}/${ref.name}`;
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
export function demoBlockMarkdown({ ref, title, description }: DemoBlock): string {
  const line = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').replaceAll('`', "'").trim();
  return ['```demo ' + demoRefKey(ref), line(title), line(description), '```'].filter(Boolean).join('\n').concat('\n');
}

export function isPageDemo(demo: DemoSource): boolean {
  return demo.source.startsWith(PAGE_SOURCE_PREFIX);
}

/** The files' own page on GitHub, at the commit they were copied from; `null` for a page's own folder. */
export function sourceAt(demo: DemoSource): string | null {
  if (isPageDemo(demo)) return null;
  if (demo.source.startsWith('https://gist.github.com/')) return `${demo.source}/${demo.commit}`;
  return `${demo.source}/tree/${demo.commit}${demo.root ? `/${demo.root}` : ''}`;
}

export function sourceLabel(demo: DemoSource): string {
  if (isPageDemo(demo)) return `${demo.root} in this page's repo`;
  const name = demo.source.replace(/^https:\/\/(gist\.)?github\.com\//, '');
  return `${name}${demo.root ? `/${demo.root}` : ''}@${demo.commit.slice(0, 7)}`;
}
