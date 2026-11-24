import { and, eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, botGrants, userPluginGrants, type Account } from '@/db/schema';
import {
  consentMissing,
  type Grant,
  type InstalledEntry,
  installedEntries,
  type InstalledPlugin,
  isBlocked,
  type PluginBot,
} from '@/lib/plugins/installed';
import { pluginOrigin } from '@/lib/plugins/origin';
import { parsePluginSource, type PluginSource, sourceKey, sourcePageUrl } from '@/lib/plugins/sources';
import {
  parseSettings,
  resolveSettings,
  type PluginSettings,
  type ResolvedSettings,
  setInSettings,
} from '@/lib/settings';
import { ApiError } from '../api/errors';
import { saveUserSettings, siteSettingsText, userSettingsRow } from '../settings';
import { baseUrlOf, pinnedSnapshot, type PluginSnapshot, snapshotPlugin } from './snapshot';
import { newestReleaseTag } from './tags';

/**
 * The plugins a reader has installed, as pages run them (`handoffs/plugins.md` Phase 2): the entries their settings
 * name (`lib/plugins/installed.ts`), each with the snapshot it runs and whether it may run: blocked by the site,
 * waiting for the reader's consent (`user_plugin_grants`), or ready.
 */

/** Settings without the plugins' own keys, which is all that `plugins*` needs. */
async function baseValues(account: Account | null): Promise<ResolvedSettings> {
  const [site, user] = await Promise.all([
    siteSettingsText(),
    account ? userSettingsRow(account.id).then((row) => row.text) : Promise.resolve(null),
  ]);
  return resolveSettings({ site: parseSettings(site), user: parseSettings(user) });
}

function githubSource(entry: InstalledEntry): PluginSource & { kind: 'github' } {
  const source = parsePluginSource(entry.source);
  if (source?.kind !== 'github') throw new Error(`not a GitHub source: ${entry.source}`);
  return { ...source, ref: entry.ref };
}

/** Failed copies, kept a few minutes so a broken plugin doesn't send every page view to GitHub. */
const failures = new Map<string, { error: string; at: number }>();
const FAILURE_TTL_MS = 5 * 60_000;

async function snapshotOf(entry: InstalledEntry, fetch: boolean, database: Database): Promise<PluginSnapshot> {
  const key = `${entry.source}@${entry.ref ?? ''}`;
  if (!fetch) {
    const pinned = await pinnedSnapshot(entry.source, entry.ref ?? '', database);
    if (!pinned) throw new ApiError(404, 'not_found', 'not copied yet');
    return pinned;
  }
  const failed = failures.get(key);
  if (failed && Date.now() - failed.at < FAILURE_TTL_MS) throw new ApiError(422, 'validation_error', failed.error);
  try {
    return await snapshotPlugin(githubSource(entry), { database });
  } catch (err) {
    const error = err instanceof ApiError ? err.message : "couldn't copy the plugin's files";
    if (!(err instanceof ApiError)) console.error(`plugin ${key}`, err);
    failures.set(key, { error, at: Date.now() });
    throw new ApiError(422, 'validation_error', error);
  }
}

async function grantsOf(account: Account | null, database: Database): Promise<Map<string, Grant & { sha: string }>> {
  if (!account) return new Map();
  const rows = await database.select().from(userPluginGrants).where(eq(userPluginGrants.accountId, account.id));
  return new Map(rows.map((row) => [row.pluginId, row]));
}

/** The bots manifests name, as this site knows them: whether each is a bot here, and its grants. */
async function botsByHandle(handles: string[], database: Database): Promise<Map<string, PluginBot>> {
  const out = new Map<string, PluginBot>();
  if (handles.length === 0) return out;
  const rows = await database
    .select({ handle: accounts.handle, kind: botGrants.kind, pattern: botGrants.pattern })
    .from(accounts)
    .leftJoin(botGrants, eq(botGrants.accountId, accounts.id))
    .where(and(inArray(accounts.handle, handles), eq(accounts.isBot, true)))
    .orderBy(botGrants.kind, botGrants.pattern);
  for (const handle of handles) out.set(handle, { handle, known: false, grants: [] });
  for (const row of rows) {
    const bot = out.get(row.handle)!;
    bot.known = true;
    if (row.kind && row.pattern) bot.grants.push({ kind: row.kind, pattern: row.pattern });
  }
  return out;
}

/**
 * Every plugin the reader's settings install, enabled or not. `fetch` copies those not copied yet (from GitHub, the
 * first time anyone installs a source at a ref); without it, they show as errors until something copies them.
 */
export async function installedPlugins(
  account: Account | null,
  options: { fetch?: boolean; database?: Database } = {},
): Promise<InstalledPlugin[]> {
  const { fetch = true, database = getDb() } = options;
  const values = await baseValues(account);
  const blocked = (values['plugins.blocked'] ?? []) as string[];
  const entries = installedEntries(values);
  const grants = await grantsOf(account, database);
  const seen = new Set<string>();
  const out: InstalledPlugin[] = [];
  for (const entry of entries) {
    const base = { source: entry.source, ref: entry.ref, enabled: entry.enabled, from: entry.from };
    const none = { permissions: [], network: [] };
    let snapshot: PluginSnapshot;
    try {
      snapshot = await snapshotOf(entry, fetch && entry.enabled, database);
    } catch (err) {
      const error = err instanceof ApiError ? err.message : 'unavailable';
      // Turned off, it isn't fetched, so that it hasn't been copied is no error.
      out.push(
        entry.enabled
          ? { ...base, status: 'error', error, plugin: null, missing: none }
          : { ...base, status: 'disabled', plugin: null, missing: none },
      );
      continue;
    }
    const plugin = {
      id: snapshot.pluginId,
      commit: snapshot.commit,
      sourceUrl: sourcePageUrl(githubSource(entry), snapshot.commit),
      baseUrl: baseUrlOf(snapshot),
      origin: pluginOrigin(snapshot.host),
      manifest: snapshot.manifest,
    };
    if (seen.has(plugin.id)) {
      out.push({ ...base, status: 'error', error: `another installed plugin is ${plugin.id}`, plugin, missing: none });
      continue;
    }
    seen.add(plugin.id);
    // A site default runs without the reader's approval, except for what only the reader can give (`identity`),
    // which it goes without until they do.
    const missing = consentMissing(entry.from, snapshot.manifest, grants.get(plugin.id) ?? null);
    const status: InstalledPlugin['status'] = !entry.enabled
      ? 'disabled'
      : isBlocked(blocked, plugin.id, plugin.commit)
        ? 'blocked'
        : entry.from === 'user' &&
            (missing.permissions.length > 0 || missing.network.length > 0 || !grants.has(plugin.id))
          ? 'consent'
          : 'ready';
    out.push({ ...base, status, plugin, missing });
  }
  const handles = [...new Set(out.flatMap((p) => (p.plugin?.manifest.bot ? [p.plugin.manifest.bot] : [])))];
  const bots = await botsByHandle(handles, database);
  for (const p of out) {
    if (p.plugin) p.plugin.bot = p.plugin.manifest.bot ? (bots.get(p.plugin.manifest.bot) ?? null) : null;
  }
  return out;
}

/**
 * The settings the reader's installed plugins declare (`contributes.settings`), so the resolver, the checker and the
 * JSON Schema know their keys. Only plugins already copied: reading settings never fetches.
 */
export async function pluginSettingsOf(
  account: Account | null,
  database: Database = getDb(),
): Promise<PluginSettings[]> {
  const plugins = await installedPlugins(account, { fetch: false, database });
  return plugins.flatMap((p) =>
    p.plugin
      ? [{ id: p.plugin.id, title: p.plugin.manifest.name, settings: p.plugin.manifest.contributes.settings }]
      : [],
  );
}

/**
 * Approve a plugin at the commit the reader runs: its grant becomes what that commit's manifest asks for. Only an
 * installed, enabled plugin at the commit it runs can be approved.
 */
export async function grantPlugin(account: Account, pluginId: string, commit: string, database: Database = getDb()) {
  const plugin = (await installedPlugins(account, { fetch: false, database })).find(
    (p) => p.plugin?.id === pluginId && p.enabled,
  );
  if (!plugin?.plugin) throw new ApiError(404, 'not_found', `${pluginId} isn't installed`);
  if (plugin.plugin.commit !== commit) {
    throw new ApiError(
      409,
      'plugin_changed',
      `${pluginId} runs at ${plugin.plugin.commit?.slice(0, 7)}, not ${commit.slice(0, 7)}`,
    );
  }
  const { permissions, network } = plugin.plugin.manifest;
  await database
    .insert(userPluginGrants)
    .values({ accountId: account.id, pluginId, sha: commit, permissions, network })
    .onConflictDoUpdate({
      target: [userPluginGrants.accountId, userPluginGrants.pluginId],
      set: { sha: commit, permissions, network, grantedAt: new Date() },
    });
}

/** Withdraw consent: the plugin shows its prompt again. */
export async function revokePlugin(account: Account, pluginId: string, database: Database = getDb()) {
  await database
    .delete(userPluginGrants)
    .where(and(eq(userPluginGrants.accountId, account.id), eq(userPluginGrants.pluginId, pluginId)));
}

/**
 * Install a plugin from a source: copy it (from GitHub, unless that commit was copied already) and add it to the
 * account's settings.json `plugins`, keeping the rest of the file as written. It still needs the reader's consent
 * to run, which the page asks for. Returns it as the page will see it.
 */
export async function installPlugin(account: Account, text: string): Promise<InstalledPlugin> {
  const source = parsePluginSource(text);
  if (!source) {
    throw new ApiError(
      422,
      'validation_error',
      'give a plugin source: github:<owner>/<repo>[/<folder>][@<ref>], or owner/repo',
    );
  }
  if (source.kind !== 'github') {
    throw new ApiError(422, 'validation_error', 'a localhost plugin runs in your browser only; load it from there');
  }
  // No ref named: the newest release, as plugins are published by tagging one; the default branch without any.
  if (source.ref === null) source.ref = await newestReleaseTag(source);
  await snapshotPlugin(source);
  const key = sourceKey(source);
  const { text: current } = await userSettingsRow(account.id);
  const entry = { enabled: true, ...(source.ref ? { ref: source.ref } : {}) };
  await saveUserSettings(account, setInSettings(current, ['plugins', key], entry));
  const installed = (await installedPlugins(account, { fetch: false })).find((p) => p.source === key);
  if (!installed) throw new Error(`installed ${key}, but it isn't listed`);
  return installed;
}

/** Remove a plugin from the account's settings.json; a site default is turned off instead. */
export async function uninstallPlugin(account: Account, text: string): Promise<void> {
  const source = parsePluginSource(text);
  if (source?.kind !== 'github') throw new ApiError(422, 'validation_error', 'not a plugin source');
  const key = sourceKey(source);
  const values = await baseValues(account);
  const isDefault = installedEntries({ ...values, plugins: {} }).some((e) => e.source === key);
  const { text: current } = await userSettingsRow(account.id);
  const next = setInSettings(current, ['plugins', key], isDefault ? { enabled: false } : undefined);
  await saveUserSettings(account, next);
}
