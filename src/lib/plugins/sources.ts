/**
 * Where a plugin comes from (`handoffs/plugins.md` Phase 2). A source is what settings.json's `plugins` key names
 * and what `plugins.default` lists:
 *
 *     github:<owner>/<repo>[/<folder>][@<ref>]     a public repo, its files copied at the commit the ref names
 *     http://localhost:<port>/                     a plugin author's dev server, unpinned, in their browser only
 *
 * `owner/repo[@ref]` and github.com links (`/tree/<ref>/<folder>`) are accepted as input and written back as the
 * first form. A source's **key** is its canonical form without the ref, lower-cased: two spellings of one repo are
 * one plugin. The ref goes in the `plugins` entry's `ref` (a tag, branch or commit), resolved to a commit when the
 * plugin is installed. Pure, shared by the server and the browser.
 */

export type PluginSource =
  | {
      kind: 'github';
      owner: string;
      repo: string;
      /** The plugin's folder in the repo, without slashes at either end; `''` for the top. */
      path: string;
      /** A tag, branch or commit; `null` for the default branch. */
      ref: string | null;
    }
  | {
      kind: 'dev';
      /** The folder the dev server serves the manifest from, ending in `/`. */
      url: string;
    };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}$/;
const FOLDER = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const REF = /^[A-Za-z0-9_.\/-]{1,200}$/;

export const MANIFEST_FILE = 'potentialpaper-plugin.json';

/** Hosts a dev source may name: the author's own machine, and nothing else. */
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function github(owner: string, repo: string, path: string, ref: string | null): PluginSource | null {
  const folder = path.replace(new RegExp(`(^|/)${MANIFEST_FILE.replace('.', '\\.')}$`), '').replace(/^\/+|\/+$/g, '');
  repo = repo.replace(/\.git$/, '');
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') return null;
  if (folder && (!FOLDER.test(folder) || folder.split('/').some((s) => s === '.' || s === '..'))) return null;
  if (ref !== null && (!REF.test(ref) || ref.includes('..'))) return null;
  return { kind: 'github', owner, repo, path: folder, ref };
}

/** A source as typed or stored, or `null` with nothing that reads as one. Never fetches. */
export function parsePluginSource(input: string): PluginSource | null {
  const text = input.trim();
  if (!text) return null;
  const prefixed = /^github:([^/\s]+)\/([^/@\s]+)((?:\/[^@\s]*)?)(?:@(\S+))?$/i.exec(text);
  if (prefixed) return github(prefixed[1], prefixed[2], prefixed[3] ?? '', prefixed[4] ?? null);
  const short = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)(?:@(\S+))?$/.exec(text);
  if (short) return github(short[1], short[2], '', short[3] ?? null);
  const url = URL.parse(text);
  if (!url) return null;
  if (url.protocol === 'http:' && DEV_HOSTS.has(url.hostname)) {
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(new RegExp(`${MANIFEST_FILE.replace('.', '\\.')}$`), '');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return { kind: 'dev', url: url.href };
  }
  if (url.protocol !== 'https:' || (url.hostname !== 'github.com' && url.hostname !== 'www.github.com')) return null;
  const [owner, repo, view, ref, ...rest] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (!owner || !repo) return null;
  if (view === undefined) return github(owner, repo, '', null);
  if ((view !== 'tree' && view !== 'blob') || !ref) return null;
  return github(owner, repo, rest.join('/'), ref);
}

/** The source as settings.json keys it: canonical, lower-cased, without the ref. */
export function sourceKey(source: PluginSource): string {
  if (source.kind === 'dev') return source.url;
  return `github:${source.owner.toLowerCase()}/${source.repo.toLowerCase()}${source.path ? `/${source.path}` : ''}`;
}

/** The repo's page on GitHub, at a commit when one is given. */
export function sourcePageUrl(source: PluginSource, commit?: string): string {
  if (source.kind === 'dev') return source.url;
  const base = `https://github.com/${source.owner}/${source.repo}`;
  if (!commit) return base;
  return `${base}/tree/${commit}${source.path ? `/${source.path}` : ''}`;
}

/** The GitHub owner a plugin's id must start with: a repo names its owner, so nobody can publish as someone else. */
export function sourceOwner(source: PluginSource): string | null {
  return source.kind === 'github' ? source.owner.toLowerCase() : null;
}
