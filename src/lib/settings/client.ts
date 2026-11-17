'use client';

import { useSyncExternalStore } from 'react';
import { CORE_SETTINGS } from './core';
import {
  checkSettings,
  EMPTY_SETTINGS,
  formatProblem,
  parseSettings,
  resolveSettings,
  type ResolvedSettings,
  setInSettings,
  type SettingsProblem,
} from './document';
import type { PluginSettings } from './spec';

/**
 * settings.json in the browser. Signed in, the document is the account's (`/api/v1/me/settings`); signed out, it
 * lives in this browser's localStorage and is offered for import at sign-in (`SettingsImport`). Either way it is
 * resolved over the site layer and the defaults, with the same code as the server's.
 *
 * Pages are the same HTML for every reader (the edge caches them), so anything a setting changes on a page is
 * applied here, after load. The last resolved values are kept in localStorage too, so a page applies them at once
 * instead of after a round trip; that copy is a cache, not the document.
 */

/** A signed-out reader's settings.json. */
export const LOCAL_SETTINGS_KEY = 'pp.settings';
/** The last resolved values, to apply before the fetch returns. */
const CACHE_KEY = 'pp.settings.resolved';

export interface SettingsState {
  /** `false` until the document has been fetched. */
  loaded: boolean;
  signedIn: boolean;
  /** The reader's settings.json, as written. */
  text: string;
  /** The site layer's text, which the reader's file sits over. */
  siteText: string;
  values: ResolvedSettings;
  problems: SettingsProblem[];
  /** The settings the reader's installed plugins declare, which `values` and `problems` take into account. */
  plugins: PluginSettings[];
}

const DEFAULTS: ResolvedSettings = resolveSettings({});
const SERVER_STATE: SettingsState = {
  loaded: false,
  signedIn: false,
  text: EMPTY_SETTINGS,
  siteText: EMPTY_SETTINGS,
  values: DEFAULTS,
  problems: [],
  plugins: [],
};

let state: SettingsState | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: settings still work for this page.
  }
}

function cachedValues(): ResolvedSettings {
  const raw = lsGet(CACHE_KEY);
  if (!raw) return DEFAULTS;
  // Re-resolved, so a cache from an older build can't hold a value this one doesn't accept.
  return resolveSettings({ user: parseSettings(raw) });
}

function current(): SettingsState {
  state ??= { ...SERVER_STATE, values: cachedValues() };
  return state;
}

function update(next: SettingsState) {
  state = next;
  if (next.loaded) lsSet(CACHE_KEY, JSON.stringify(next.values));
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // The first reader on the page fetches the document.
  if (!current().loaded && !loading) void load();
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  // Another tab changed a signed-out reader's file.
  window.addEventListener('storage', (e) => {
    if (e.key === LOCAL_SETTINGS_KEY && state && !state.signedIn) void load();
  });
}

interface MySettingsBody {
  text: string;
  values: ResolvedSettings;
  problems: SettingsProblem[];
  plugins: PluginSettings[];
}

async function fetchJson<T>(url: string): Promise<{ status: number; body: T | null }> {
  const res = await fetch(url, { cache: 'no-store' });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}

/** Fetch the document again: at load, and when the reader signs in or out. */
export function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const me = await fetchJson<MySettingsBody>('/api/v1/me/settings');
      const site = await fetchJson<{ text: string; plugins: PluginSettings[] }>('/api/v1/settings');
      const siteText = site.body?.text ?? EMPTY_SETTINGS;
      if (me.body) {
        update({ loaded: true, signedIn: true, siteText, ...me.body });
        return;
      }
      const text = lsGet(LOCAL_SETTINGS_KEY) ?? EMPTY_SETTINGS;
      // Signed out, the site's default plugins are the installed ones.
      const plugins = site.body?.plugins ?? [];
      update({
        loaded: true,
        signedIn: false,
        text,
        siteText,
        values: resolveSettings({ site: parseSettings(siteText), user: parseSettings(text) }, plugins),
        problems: checkSettings(text, plugins),
        plugins,
      });
    } catch {
      // Offline or the API is down: keep what we have.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Reload if the reader signed in or out since the document was fetched (`NavUser` says). */
export function noteSignedIn(signedIn: boolean) {
  if (state?.loaded && state.signedIn !== signedIn) void load();
}

export class SettingsError extends Error {
  constructor(
    message: string,
    readonly problems: SettingsProblem[],
  ) {
    super(message);
  }
}

/**
 * Replace the reader's settings.json. Throws a `SettingsError` listing every error, and saves nothing, if it has
 * any. Returns the problems left, which are warnings.
 */
export async function saveSettings(text: string): Promise<SettingsProblem[]> {
  const s = current();
  if (!s.signedIn) {
    const problems = checkSettings(text, s.plugins);
    const errors = problems.filter((p) => p.severity === 'error');
    if (errors.length) throw new SettingsError(errors.map(formatProblem).join('\n'), problems);
    lsSet(LOCAL_SETTINGS_KEY, text);
    update({
      ...s,
      text,
      values: resolveSettings({ site: parseSettings(s.siteText), user: parseSettings(text) }, s.plugins),
      problems,
    });
    return problems;
  }
  const res = await fetch('/api/v1/me/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const problems: SettingsProblem[] = body?.error?.details?.problems ?? [];
    throw new SettingsError(body?.error?.message ?? `couldn't save (${res.status})`, problems);
  }
  update({ ...s, ...(body as MySettingsBody), signedIn: true });
  return (body as MySettingsBody).problems;
}

/**
 * Set one key of the reader's settings.json (`undefined` removes it), keeping the rest of the file as written: what a
 * plugin's `settings.set` does.
 */
export async function setSetting(key: string | string[], value: unknown): Promise<void> {
  if (!current().loaded) await load();
  await saveSettings(setInSettings(current().text, key, value));
}

/** The current state, outside React. */
export function settingsSnapshot(): SettingsState {
  return current();
}

/** Be told when the settings change, outside React. */
export function subscribeSettings(listener: () => void): () => void {
  return subscribe(listener) as () => void;
}

/** A signed-out reader's file still in this browser; `null` when there is none worth importing. */
export function localSettingsText(): string | null {
  const text = lsGet(LOCAL_SETTINGS_KEY);
  return text && Object.keys(parseSettings(text)).length > 0 ? text : null;
}

export function clearLocalSettings() {
  lsSet(LOCAL_SETTINGS_KEY, null);
  // A new snapshot, so readers of `localSettingsText` render again.
  if (state) update({ ...state });
}

export function useSettings(): SettingsState {
  return useSyncExternalStore(subscribe, current, () => SERVER_STATE);
}

/** One setting's value. The server and the first client render see the default, so hydration matches. */
export function useSetting<T = unknown>(key: string): T {
  return useSyncExternalStore(
    subscribe,
    () => current().values[key] as T,
    () => (CORE_SETTINGS[key]?.default ?? DEFAULTS[key]) as T,
  );
}
