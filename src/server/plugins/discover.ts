import { parsePluginSource, sourceKey } from '@/lib/plugins/sources';

/**
 * Plugins people can find and install (`handoffs/plugins.md` Phase 3): the public GitHub repos tagged with the topic
 * `potentialpaper-plugin` (the guide at `/plugins.md` has every plugin's repo add it), most starred first. Ported
 * from Presio's `server/routes/plugins.ts`.
 *
 * Search is limited to 10 requests a minute per address without a token, and every `/settings/plugins` would spend
 * one, so the server asks once per five minutes and serves everyone from that answer. `GITHUB_TOKEN`, when set,
 * lifts the limit. While GitHub fails, the last list stands in. This only lists repos: what a plugin is and may do is
 * read from its manifest when it is installed, and it still asks for the reader's consent.
 */

export const PLUGIN_TOPIC = 'potentialpaper-plugin';
export const DISCOVER_CACHE_MS = 5 * 60 * 1000;
/** After a failed search, how long to serve what we have before asking again. */
const RETRY_MS = 60 * 1000;
const PER_PAGE = 100;

export interface DiscoveredPlugin {
  /** What to install it by, as settings.json keys it: `github:<owner>/<repo>`. */
  source: string;
  owner: string;
  repo: string;
  description: string | null;
  stars: number;
  /** ISO time of the last push. */
  pushedAt: string | null;
  htmlUrl: string;
  avatarUrl: string | null;
  topics: string[];
}

export interface PluginDirectory {
  plugins: DiscoveredPlugin[];
  /** When GitHub was asked for this list. */
  fetchedAt: string;
  /** The list is older than five minutes because GitHub couldn't be asked. */
  stale: boolean;
}

interface SearchItem {
  name: string;
  owner: { login: string; avatar_url?: string };
  html_url: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string | null;
  topics?: string[];
  archived?: boolean;
  private?: boolean;
}

type Fetch = typeof fetch;

/** The topic's repos, as GitHub's search returns them, without those no source can name. */
async function searchGitHub(fetchImpl: Fetch): Promise<DiscoveredPlugin[]> {
  const q = encodeURIComponent(`topic:${PLUGIN_TOPIC} archived:false is:public`);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'potentialpaper',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchImpl(
    `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${PER_PAGE}`,
    { headers, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`GitHub search failed (HTTP ${res.status})`);
  const body = (await res.json()) as { items?: SearchItem[] };
  const plugins: DiscoveredPlugin[] = [];
  for (const item of body.items ?? []) {
    if (item.archived || item.private) continue;
    const source = parsePluginSource(`${item.owner?.login}/${item.name}`);
    if (source?.kind !== 'github') continue;
    plugins.push({
      source: sourceKey(source),
      owner: item.owner.login,
      repo: item.name,
      description: item.description,
      stars: item.stargazers_count ?? 0,
      pushedAt: item.pushed_at,
      htmlUrl: item.html_url,
      avatarUrl: item.owner.avatar_url ?? null,
      topics: item.topics ?? [],
    });
  }
  return plugins;
}

/**
 * The list, cached for five minutes. One search runs at a time; a stale list stands in while GitHub can't be asked,
 * and with no list at all, the error is thrown.
 */
export function pluginDirectory(fetchImpl?: Fetch, now: () => number = Date.now) {
  let cached: { at: number; plugins: DiscoveredPlugin[] } | null = null;
  let nextTry = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = () =>
    (inFlight ??= searchGitHub(fetchImpl ?? globalThis.fetch)
      .then((plugins) => {
        cached = { at: now(), plugins };
      })
      .catch((err: Error) => {
        nextTry = now() + RETRY_MS;
        if (!cached) throw err;
        console.warn(`[plugins] ${err.message}; serving the list from ${new Date(cached.at).toISOString()}`);
      })
      .finally(() => {
        inFlight = null;
      }));

  return async function list(): Promise<PluginDirectory> {
    const t = now();
    if ((!cached || t - cached.at >= DISCOVER_CACHE_MS) && t >= nextTry) await refresh();
    if (!cached) throw new Error('GitHub search is unavailable; try again shortly');
    const { at, plugins } = cached;
    return { plugins, fetchedAt: new Date(at).toISOString(), stale: now() - at >= DISCOVER_CACHE_MS };
  };
}

/** The site's directory, shared by every request this process serves. */
export const discoverPlugins = pluginDirectory();
