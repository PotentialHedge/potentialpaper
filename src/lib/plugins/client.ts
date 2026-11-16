'use client';

import { useSyncExternalStore } from 'react';
import { load as reloadSettings, settingsSnapshot, subscribeSettings } from '../settings/client';
import type { InstalledPlugin } from './installed';
import { validateManifest } from './manifest';
import { MANIFEST_FILE, parsePluginSource } from './sources';

/**
 * The reader's plugins in the browser (`GET /api/v1/plugins/installed`), fetched once per page, and the plugins a
 * plugin author loads from their own dev server (`http://localhost:<port>/`). Dev plugins live in this browser's
 * localStorage only, run unpinned (whatever the dev server serves now), and need no consent: the author added them
 * on their own machine. Pages are the same HTML for every reader, so plugins are drawn here, after load.
 */

/** This browser's dev plugin sources (`http://localhost:<port>/`). */
export const DEV_PLUGINS_KEY = 'pp.plugins.dev';

export interface PluginsState {
  loaded: boolean;
  plugins: InstalledPlugin[];
  viewer: { signedIn: boolean; isOwner: boolean };
}

const EMPTY: PluginsState = { loaded: false, plugins: [], viewer: { signedIn: false, isOwner: false } };

const states = new Map<string, PluginsState>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

export function devSources(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DEV_PLUGINS_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveDevSources(list: string[]) {
  try {
    localStorage.setItem(DEV_PLUGINS_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: nothing to keep it in.
  }
  reloadPlugins();
}

/** Load a plugin from a dev server on this machine, in this browser only. */
export function addDevPlugin(url: string): string {
  const source = parsePluginSource(url);
  if (source?.kind !== 'dev') throw new Error('a dev plugin is served from http://localhost:<port>/');
  saveDevSources([...devSources().filter((s) => s !== source.url), source.url]);
  return source.url;
}

export function removeDevPlugin(url: string) {
  saveDevSources(devSources().filter((s) => s !== url));
}

/** A dev server's plugin, as the server would list it; its manifest checked here, with the same validator. */
async function devPlugin(url: string): Promise<InstalledPlugin> {
  const base = { source: url, ref: null, enabled: true, from: 'dev' as const, missing: { permissions: [], network: [] } };
  try {
    const res = await fetch(new URL(MANIFEST_FILE, url), { cache: 'no-store' });
    if (!res.ok) throw new Error(`${MANIFEST_FILE}: HTTP ${res.status}`);
    const report = validateManifest(await res.json());
    if (!report.manifest) throw new Error(report.errors.join('\n'));
    return {
      ...base,
      status: 'ready',
      plugin: {
        id: report.manifest.id,
        commit: null,
        sourceUrl: url,
        baseUrl: url,
        origin: new URL(url).origin,
        manifest: report.manifest,
      },
    };
  } catch (e) {
    return {
      ...base,
      status: 'error',
      error: `couldn't load the dev plugin at ${url} (is its server running, with CORS on?): ${(e as Error).message}`,
      plugin: null,
    };
  }
}

function key(page: string | null) {
  return page ?? '';
}

async function load(page: string | null) {
  const query = page ? `?page=${encodeURIComponent(page)}` : '';
  try {
    const [res, dev] = await Promise.all([
      fetch(`/api/v1/plugins/installed${query}`, { cache: 'no-store' }),
      Promise.all(devSources().map(devPlugin)),
    ]);
    const body = res.ok ? ((await res.json()) as Omit<PluginsState, 'loaded'>) : { plugins: [], viewer: EMPTY.viewer };
    // A dev plugin stands in for an installed one of the same id: the author is working on it.
    const devIds = new Set(dev.flatMap((p) => (p.plugin ? [p.plugin.id] : [])));
    const installed = body.plugins.filter((p) => !p.plugin || !devIds.has(p.plugin.id));
    states.set(key(page), { loaded: true, plugins: [...installed, ...dev], viewer: body.viewer });
  } catch {
    states.set(key(page), { ...EMPTY, loaded: true });
  } finally {
    loading.delete(key(page));
    notify();
  }
}

/** Fetch every page's plugins again: after a grant, an install, or signing in or out. */
export function reloadPlugins() {
  for (const page of states.keys()) {
    if (!loading.has(page)) loading.set(page, load(page || null));
  }
}

/**
 * What the plugin list depends on in settings: who is signed in, and the `plugins` key. When either changes (sign in,
 * an install, an edit of settings.json), the pages' plugins are fetched again.
 */
let watched: string | null = null;
let watching = false;
function watchSettings() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  subscribeSettings(() => {
    const s = settingsSnapshot();
    if (!s.loaded) return;
    const next = JSON.stringify([s.signedIn, s.values.plugins ?? null]);
    if (watched !== null && watched !== next) reloadPlugins();
    watched = next;
  });
}

function subscribe(listener: () => void) {
  watchSettings();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The reader's plugins, for the page with this identifier (or none, on a plugin's own page). */
export function usePlugins(page: string | null): PluginsState {
  return useSyncExternalStore(
    (listener) => {
      const k = key(page);
      if (!states.has(k) && !loading.has(k)) loading.set(k, load(page));
      return subscribe(listener);
    },
    () => states.get(key(page)) ?? EMPTY,
    () => EMPTY,
  );
}

/** Approve a plugin at the commit it runs. */
export async function grantPlugin(pluginId: string, commit: string): Promise<void> {
  const res = await fetch('/api/v1/me/plugins/grants', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plugin: pluginId, commit }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? `couldn't approve it (${res.status})`);
  }
  reloadPlugins();
}

/** Install a plugin from a GitHub source into the reader's settings.json. */
export async function installPlugin(source: string): Promise<InstalledPlugin> {
  const res = await fetch('/api/v1/me/plugins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `couldn't install it (${res.status})`);
  // Its settings join the reader's, and it joins the pages; the settings change reloads the plugins.
  void reloadSettings();
  return body as InstalledPlugin;
}
