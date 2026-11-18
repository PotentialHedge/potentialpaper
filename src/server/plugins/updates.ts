import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { userPluginGrants, type Account } from '@/db/schema';
import { type InstalledPlugin, missingConsent } from '@/lib/plugins/installed';
import type { PluginPermission } from '@/lib/plugins/manifest';
import { parsePluginSource, type PluginSource, sourceKey } from '@/lib/plugins/sources';
import { updateFor } from '@/lib/plugins/versions';
import { setInSettings } from '@/lib/settings';
import { ApiError } from '../api/errors';
import { saveUserSettings, userSettingsRow } from '../settings';
import { grantPlugin, installedPlugins } from './installed';
import { snapshotPlugin } from './snapshot';
import { FRESH_TAGS_MS, newestReleaseTag, repoTags } from './tags';

/**
 * Updates (`handoffs/plugins.md` Phase 3). A plugin is released by tagging its repo (`v1.2.0`); a reader whose plugin
 * runs an older `version` is offered the newest release. Updating sets the entry's `ref` in their settings.json to the
 * new tag, so it moves that reader only: the site-wide pin of a ref (`plugin_refs`) never moves under anyone.
 *
 * An update that asks for nothing new switches at once (consent is by coverage). One that asks for a new permission
 * or network origin is described first, and switches only when the reader approves it, in a browser, as consent
 * always is.
 */

export interface PluginUpdate {
  source: string;
  pluginId: string;
  /** What it runs now. */
  current: { ref: string | null; commit: string | null; version: string };
  /** The release to move to. */
  latest: { tag: string; commit: string; version: string };
}

function githubOf(source: string): PluginSource & { kind: 'github' } {
  const parsed = parsePluginSource(source);
  if (parsed?.kind !== 'github') throw new ApiError(422, 'validation_error', 'not a plugin source');
  return parsed;
}

/**
 * Each installed plugin with a newer release than the version it runs. With `pluginId`, only that one, asking GitHub
 * afresh (its own page checks it, so a release shows there at once).
 */
export async function pluginUpdates(
  account: Account | null,
  database: Database = getDb(),
  pluginId?: string,
): Promise<PluginUpdate[]> {
  const plugins = await installedPlugins(account, { fetch: false, database });
  const out: PluginUpdate[] = [];
  await Promise.all(
    plugins.map(async (p) => {
      if (!p.plugin || p.from === 'dev' || (pluginId && p.plugin.id !== pluginId)) return;
      const source = githubOf(p.source);
      const tags = await repoTags(source.owner, source.repo, pluginId ? FRESH_TAGS_MS : undefined);
      if (!tags) return;
      const update = updateFor(tags.keys(), p.plugin.manifest.version);
      if (!update || update.tag === p.ref) return;
      out.push({
        source: p.source,
        pluginId: p.plugin.id,
        current: { ref: p.ref, commit: p.plugin.commit, version: p.plugin.manifest.version },
        latest: { tag: update.tag, commit: tags.get(update.tag)!, version: update.version },
      });
    }),
  );
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

export type UpdateResult =
  | { status: 'updated'; plugin: InstalledPlugin }
  | {
      /** Nothing was switched: the new version asks for what `missing` lists, which the reader must approve. */
      status: 'consent';
      to: { ref: string; commit: string; version: string; name: string };
      missing: { permissions: PluginPermission[]; network: string[] };
    };

/**
 * Move an installed plugin to another ref (by default its newest release). The new commit is copied first, so a
 * broken release is refused before anything changes. `approve` (only from a browser session; the route checks) gives
 * consent to what the new version asks for and switches; without it, an update that asks for more is only described.
 */
export async function updatePlugin(
  account: Account,
  input: { source: string; ref?: string | null; approve?: boolean },
  database: Database = getDb(),
): Promise<UpdateResult> {
  const source = githubOf(input.source);
  const key = sourceKey(source);
  const installed = (await installedPlugins(account, { fetch: false, database })).find((p) => p.source === key);
  if (!installed) throw new ApiError(404, 'not_found', `${key} isn't installed`);
  const ref = input.ref ?? source.ref ?? (await newestReleaseTag(source));
  if (!ref) throw new ApiError(422, 'validation_error', `${key} has no release to update to; name a ref`);

  const snapshot = await snapshotPlugin({ ...source, ref }, { database });
  if (installed.plugin && snapshot.pluginId !== installed.plugin.id) {
    throw new ApiError(
      422,
      'validation_error',
      `${key}@${ref} is ${snapshot.pluginId}, not ${installed.plugin.id}; install it as a plugin of its own`,
    );
  }
  const [grant] = await database
    .select()
    .from(userPluginGrants)
    .where(and(eq(userPluginGrants.accountId, account.id), eq(userPluginGrants.pluginId, snapshot.pluginId)));
  const missing = missingConsent(snapshot.manifest, grant ?? null);
  // A site default runs without a grant; moved to another ref it becomes the reader's, which needs one.
  const needsConsent = !grant || missing.permissions.length > 0 || missing.network.length > 0;
  if (needsConsent && !input.approve) {
    return {
      status: 'consent',
      to: { ref, commit: snapshot.commit, version: snapshot.manifest.version, name: snapshot.manifest.name },
      missing,
    };
  }

  const { text } = await userSettingsRow(account.id);
  await saveUserSettings(account, setInSettings(text, ['plugins', key], { enabled: installed.enabled, ref }));
  if (needsConsent) await grantPlugin(account, snapshot.pluginId, snapshot.commit, database);
  const plugin = (await installedPlugins(account, { fetch: false, database })).find((p) => p.source === key);
  if (!plugin) throw new Error(`updated ${key}, but it isn't listed`);
  return { status: 'updated', plugin };
}
