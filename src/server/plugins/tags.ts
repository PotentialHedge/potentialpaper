import { type PluginSource } from '@/lib/plugins/sources';
import { newestRelease } from '@/lib/plugins/versions';
import { listTags } from '../demos/github';

/**
 * A plugin repo's tags, which are its releases (`handoffs/plugins.md` Phase 3), through git's ref listing: no token
 * and no hourly limit, as copying a plugin needs.
 */

/** Tags, per repo, cached ten minutes: one ref listing per repo however many readers look. */
const TAGS_TTL_MS = 10 * 60_000;
const tagCache = new Map<string, { at: number; tags: Map<string, string> | null }>();

/** How fresh a check on one plugin's own page is: a release shows within seconds of its tag. */
export const FRESH_TAGS_MS = 15_000;

/**
 * A repo's tags, or `null` when GitHub couldn't be asked (an update check then says nothing). `maxAgeMs`: how old a
 * cached listing may be.
 */
export async function repoTags(
  owner: string,
  repo: string,
  maxAgeMs: number = TAGS_TTL_MS,
): Promise<Map<string, string> | null> {
  const key = `${owner}/${repo}`.toLowerCase();
  const hit = tagCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.tags;
  let tags: Map<string, string> | null;
  try {
    tags = await listTags(owner, repo);
  } catch (err) {
    console.warn(`[plugins] tags of ${key}: ${(err as Error).message}`);
    tags = null;
  }
  tagCache.set(key, { at: Date.now(), tags });
  return tags;
}

/** Forget cached tags (tests, and after a reader asks to check again). */
export function forgetTags() {
  tagCache.clear();
}

/** The newest release tag of a source's repo, for installing a plugin by `owner/repo` with no ref. */
export async function newestReleaseTag(source: PluginSource & { kind: 'github' }): Promise<string | null> {
  const tags = await repoTags(source.owner, source.repo);
  return tags ? (newestRelease(tags.keys())?.tag ?? null) : null;
}
