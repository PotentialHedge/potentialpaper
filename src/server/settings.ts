import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { siteSettings, userSettings, type Account } from '@/db/schema';
import {
  checkSettings,
  EMPTY_SETTINGS,
  formatProblem,
  isEditable,
  isSettingsObject,
  parseSettings,
  resolveSettings,
  setInSettings,
  type PluginSettings,
  type ResolvedSettings,
  type SettingsProblem,
} from '@/lib/settings';
import type { HideUntil } from '@/lib/scope-stats';
import { shownFromSettings, USER_SHOW_SETTINGS } from '@/lib/user-pages';
import { ApiError } from './api/errors';
import { pluginSettingsOf } from './plugins/installed';
import { afterProfileChange } from './user-pages';

/**
 * settings.json on the server (DESIGN.md §10): each account's document (`user_settings`) over the site layer
 * (`site_settings`) over the defaults (`lib/settings/core.ts` and installed plugins' `contributes.settings`).
 * Texts are stored as written and parsed when read.
 */

/**
 * The settings the account's installed plugins declare (`contributes.settings`): the `plugins` key and the site's
 * `plugins.default`, through the manifests of the copies they run (`server/plugins/installed.ts`). Signed out, the
 * site's defaults only.
 */
export async function installedPluginSettings(account: Account | null): Promise<PluginSettings[]> {
  return pluginSettingsOf(account);
}

// The site layer changes rarely and is read on every settings request: kept for a few seconds per process.
const SITE_TTL_MS = 10_000;
let siteCache: { text: string; at: number } | null = null;

/** The site layer's text, `{}` when no admin has set one. */
export async function siteSettingsText(): Promise<string> {
  if (siteCache && Date.now() - siteCache.at < SITE_TTL_MS) return siteCache.text;
  const [row] = await getDb().select({ doc: siteSettings.doc }).from(siteSettings).where(eq(siteSettings.id, 1));
  siteCache = { text: row?.doc ?? EMPTY_SETTINGS, at: Date.now() };
  return siteCache.text;
}

export async function userSettingsRow(accountId: string): Promise<{ text: string; updatedAt: Date | null }> {
  const [row] = await getDb()
    .select({ doc: userSettings.doc, updatedAt: userSettings.updatedAt })
    .from(userSettings)
    .where(eq(userSettings.accountId, accountId));
  return { text: row?.doc ?? EMPTY_SETTINGS, updatedAt: row?.updatedAt ?? null };
}

export interface SettingsView {
  /** The settings of the plugins the account has installed, which `values` and `problems` take into account. */
  plugins: PluginSettings[];
  /** The account's settings.json, as written. */
  text: string;
  /** Every known setting's value: the user's where it reads, else the site's, else the default. */
  values: ResolvedSettings;
  /** What's wrong with the text as it stands, warnings included (a stored file has no errors when saved). */
  problems: SettingsProblem[];
  updatedAt: Date | null;
}

export async function settingsFor(account: Account): Promise<SettingsView> {
  const [{ text, updatedAt }, site, plugins] = await Promise.all([
    userSettingsRow(account.id),
    siteSettingsText(),
    installedPluginSettings(account),
  ]);
  return {
    plugins,
    text,
    values: resolveSettings({ site: parseSettings(site), user: parseSettings(text) }, plugins),
    problems: checkSettings(text, plugins),
    updatedAt,
  };
}

/** The defaults and the site layer, for a reader who isn't signed in. */
export async function siteSettingsView(): Promise<{
  text: string;
  values: ResolvedSettings;
  plugins: PluginSettings[];
}> {
  const [text, plugins] = await Promise.all([siteSettingsText(), installedPluginSettings(null)]);
  return { text, values: resolveSettings({ site: parseSettings(text) }, plugins), plugins };
}

/** Throw a 422 that lists every error in the text, one per line, each naming its key. */
function refuse(problems: SettingsProblem[]): never {
  const errors = problems.filter((p) => p.severity === 'error');
  throw new ApiError(
    422,
    'validation_error',
    `settings.json has ${errors.length === 1 ? 'a problem' : `${errors.length} problems`}:\n${errors
      .map(formatProblem)
      .join('\n')}`,
    { problems },
  );
}

/** Replace the account's settings.json, if it has no errors. Warnings don't stop it. */
export async function saveUserSettings(account: Account, text: string): Promise<SettingsView> {
  const problems = checkSettings(text, await installedPluginSettings(account));
  if (problems.some((p) => p.severity === 'error')) refuse(problems);
  const before = shownFromSettings(
    resolveSettings({ user: parseSettings((await userSettingsRow(account.id)).text) }),
    account.showInstitution,
  );
  await getDb()
    .insert(userSettings)
    .values({ accountId: account.id, doc: text })
    .onConflictDoUpdate({ target: userSettings.accountId, set: { doc: text, updatedAt: sql`now()` } });
  // What the account's page shows changed: it and its papers are rendered again.
  const after = shownFromSettings(resolveSettings({ user: parseSettings(text) }), account.showInstitution);
  if (USER_SHOW_SETTINGS.some((item) => before[item] !== after[item])) await afterProfileChange(account);
  return settingsFor(account);
}

/**
 * Change some keys of the account's settings.json, keeping the rest of the file, its comments and order, as written:
 * each key to its new value, or out of the file (back to the default) for `null`. For agents and scripts, which
 * then needn't rewrite the whole file. Checked and saved as a whole file is.
 */
export async function patchUserSettings(account: Account, changes: unknown): Promise<SettingsView> {
  if (!isSettingsObject(changes)) {
    throw new ApiError(422, 'validation_error', 'the body is a JSON object of settings: { "<key>": <value> | null }');
  }
  let { text } = await userSettingsRow(account.id);
  if (!isEditable(text)) {
    throw new ApiError(422, 'validation_error', "the account's settings.json doesn't parse; replace it whole with PUT");
  }
  for (const [key, value] of Object.entries(changes))
    text = setInSettings(text, key, value === null ? undefined : value);
  return saveUserSettings(account, text);
}

/**
 * Replace the site layer (`npm run settings:site`). Checked against the core settings only: a site file naming a
 * plugin's settings is kept with a warning, as a user's is.
 */
export async function saveSiteSettings(text: string): Promise<SettingsProblem[]> {
  const problems = checkSettings(text, [], 'site');
  if (problems.some((p) => p.severity === 'error')) refuse(problems);
  await getDb()
    .insert(siteSettings)
    .values({ id: 1, doc: text })
    .onConflictDoUpdate({ target: siteSettings.id, set: { doc: text, updatedAt: sql`now()` } });
  siteCache = null;
  return problems;
}

/** The site's `plugins.venueStats.hideUntil`: whether score statistics wait for a venue's decisions. */
export async function venueStatsHideUntil(): Promise<HideUntil> {
  const values = resolveSettings({ site: parseSettings(await siteSettingsText()) }, []);
  return values['plugins.venueStats.hideUntil'] === 'decisions' ? 'decisions' : 'never';
}
