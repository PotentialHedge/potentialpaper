import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { siteSettings, userSettings, type Account } from '@/db/schema';
import {
  checkSettings,
  EMPTY_SETTINGS,
  formatProblem,
  parseSettings,
  resolveSettings,
  type PluginSettings,
  type ResolvedSettings,
  type SettingsProblem,
} from '@/lib/settings';
import { ApiError } from './api/errors';

/**
 * settings.json on the server (DESIGN.md §10): each account's document (`user_settings`) over the site layer
 * (`site_settings`) over the defaults (`lib/settings/core.ts` and installed plugins' `contributes.settings`).
 * Texts are stored as written and parsed when read.
 */

/**
 * The settings the account's installed plugins declare. None yet: the plugin host (`handoffs/plugins.md` Phase 2)
 * reads the `plugins` key and its manifests here, and everything below already takes the list.
 */
export async function installedPluginSettings(_account: Account | null): Promise<PluginSettings[]> {
  void _account;
  return [];
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
    text,
    values: resolveSettings({ site: parseSettings(site), user: parseSettings(text) }, plugins),
    problems: checkSettings(text, plugins),
    updatedAt,
  };
}

/** The defaults and the site layer, for a reader who isn't signed in. */
export async function siteSettingsView(): Promise<{ text: string; values: ResolvedSettings }> {
  const text = await siteSettingsText();
  return { text, values: resolveSettings({ site: parseSettings(text) }) };
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
  await getDb()
    .insert(userSettings)
    .values({ accountId: account.id, doc: text })
    .onConflictDoUpdate({ target: userSettings.accountId, set: { doc: text, updatedAt: sql`now()` } });
  return settingsFor(account);
}

/**
 * Replace the site layer (`npm run settings:site`). Checked against the core settings only: a site file naming a
 * plugin's settings is kept with a warning, as a user's is.
 */
export async function saveSiteSettings(text: string): Promise<SettingsProblem[]> {
  const problems = checkSettings(text);
  if (problems.some((p) => p.severity === 'error')) refuse(problems);
  await getDb()
    .insert(siteSettings)
    .values({ id: 1, doc: text })
    .onConflictDoUpdate({ target: siteSettings.id, set: { doc: text, updatedAt: sql`now()` } });
  siteCache = null;
  return problems;
}
