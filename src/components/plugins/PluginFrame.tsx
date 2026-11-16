'use client';

import { useEffect, useRef, useState } from 'react';
import { type Connection, connect, HostError, type HostServices } from '@/lib/plugins/host';
import type { InstalledPlugin } from '@/lib/plugins/installed';
import { API_VERSION } from '@/lib/plugins/manifest';
import {
  BOOT_MESSAGE,
  type FrameContext,
  HELLO_MESSAGE,
  HOST_METHODS,
  MAX_STORAGE_BYTES,
  PROTOCOL_VERSION,
  type Theme,
  THEME_TOKENS,
} from '@/lib/plugins/protocol';
import { parseSettings, resolveSettings } from '@/lib/settings/document';
import { settingsSnapshot, setSetting, subscribeSettings } from '@/lib/settings/client';
import { qualify } from '@/lib/settings/spec';
import type { PluginPageData } from './PluginPage';

/**
 * One frame of a plugin (DESIGN.md §10): its `main` HTML from its own origin, in a sandbox that lets it run scripts
 * and keep its own origin's storage and nothing else. It starts when it comes near the screen, so a page of plugins
 * costs nothing until scrolled to. Its only way to the page is the RPC (`lib/plugins/host.ts`): the frame says hello,
 * the page answers with a port and the context, and from then on the page answers its calls, checked against the
 * permissions the reader granted, and tells it when the theme or its settings change. It takes the height it asks
 * for (`ui.setHeight`, which the SDK sends as its body grows).
 */

export type ReadyPlugin = InstalledPlugin & { plugin: NonNullable<InstalledPlugin['plugin']> };

const SANDBOX = 'allow-scripts allow-same-origin';
const START_HEIGHT = 120;

/** The page's design tokens and whether it is light or dark, as plugins get them. */
export function readTheme(): Theme {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = style.getPropertyValue(name.startsWith('font-') ? `--${name}` : `--color-${name}`).trim();
    if (value) tokens[name] = value;
  }
  const scheme = style.colorScheme;
  const dark = scheme.includes('dark') && !scheme.includes('light');
  return { mode: dark || isDark(tokens.bg) ? 'dark' : 'light', tokens };
}

/** Whether a colour, as CSS gives it, is a dark one. */
function isDark(color: string | undefined): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color ?? '');
  if (!hex) return false;
  const n = parseInt(hex[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}

/** The plugin's own settings, by name, as they resolve for the reader. */
function pluginSettings(plugin: ReadyPlugin): Record<string, unknown> {
  const s = settingsSnapshot();
  const specs = plugin.plugin.manifest.contributes.settings;
  const values = resolveSettings({ site: parseSettings(s.siteText), user: parseSettings(s.text) }, [
    { id: plugin.plugin.id, settings: specs },
  ]);
  return Object.fromEntries(Object.keys(specs).map((name) => [name, values[qualify(plugin.plugin.id, name)]]));
}

const localStorageKey = (pluginId: string) => `pp.plugin-storage.${pluginId}`;

function localStorageData(pluginId: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(localStorage.getItem(localStorageKey(pluginId)) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`/api/v1${path}`);
  const body = await res.json().catch(() => null);
  if (res.ok) return body;
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  throw new HostError(res.status === 404 ? 'Unavailable' : res.status < 500 ? 'InvalidParams' : 'Internal', message);
}

/** An NDJSON route of the site's API: its rows, and the cursor of the chunk after. */
async function apiLines(path: string): Promise<{ rows: unknown[]; next: string | null }> {
  const res = await fetch(`/api/v1${path}`);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    throw new HostError(res.status === 404 ? 'Unavailable' : res.status < 500 ? 'InvalidParams' : 'Internal', message);
  }
  const text = await res.text();
  const rows = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown);
  return { rows, next: res.headers.get('x-next-cursor') };
}

interface Latest {
  plugin: ReadyPlugin;
  page: PluginPageData | null;
  viewer: { signedIn: boolean; isOwner: boolean };
  surface: PluginSurface;
}

/** What a frame knows: `pp.context` at boot, and `context.get`. */
function frameContext({ plugin: p, page: pg, viewer: v, surface: s }: Latest): FrameContext {
  return {
    plugin: {
      id: p.plugin.id,
      name: p.plugin.manifest.name,
      version: p.plugin.manifest.version,
      sha: p.plugin.commit,
      dev: p.from === 'dev',
    },
    surface:
      s.type === 'panel'
        ? { type: 'panel', panel: s.id, slot: s.slot ?? '' }
        : { type: 'page', page: s.id, path: s.path ?? [] },
    page: pg?.page ?? null,
    scopes: pg?.scopes ?? [],
    viewer: v,
    theme: readTheme(),
    settings: pluginSettings(p),
    site: window.location.origin,
    methods: Object.keys(HOST_METHODS),
  };
}

export interface PluginSurface {
  type: 'panel' | 'page';
  /** The panel's or page's id. */
  id: string;
  /** A panel's slot (`venue.main`); a page's path after its id. */
  slot?: string;
  path?: string[];
}

export function PluginFrame({
  plugin,
  surface,
  page,
  viewer,
  title,
  onConnect,
}: {
  plugin: ReadyPlugin;
  surface: PluginSurface;
  page: PluginPageData | null;
  viewer: { signedIn: boolean; isOwner: boolean };
  title: string;
  onConnect?: (connection: Connection | null) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [started, setStarted] = useState(false);
  const [height, setHeight] = useState(START_HEIGHT);
  // The latest of what the page knows, for services that outlive a render.
  const latest = useRef({ plugin, page, viewer, surface, onConnect });
  const connectionRef = useRef<Connection | null>(null);
  useEffect(() => {
    latest.current = { plugin, page, viewer, surface, onConnect };
  });

  const { origin } = plugin.plugin;
  const src = new URL(plugin.plugin.manifest.main, plugin.plugin.baseUrl).href;

  // Start once near the screen, and keep running from then on.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || started) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, [started]);

  useEffect(() => {
    if (!started) return;
    const frame = frameRef.current;
    if (!frame) return;
    let connection: Connection | null = null;

    const context = () => frameContext(latest.current);
    const services: HostServices = {
      context,
      // A site default, or a dev plugin, runs with what it asks for; any other with what the reader granted, which
      // the server checked covers it before listing it as ready.
      get permissions() {
        return latest.current.plugin.plugin.manifest.permissions;
      },
      get settingSpecs() {
        return latest.current.plugin.plugin.manifest.contributes.settings;
      },
      settings: () => pluginSettings(latest.current.plugin),
      setSetting: async (name, value) => {
        await setSetting(qualify(latest.current.plugin.plugin.id, name), value === null ? undefined : value);
      },
      storageGet: async () => {
        const id = latest.current.plugin.plugin.id;
        if (!settingsSnapshot().signedIn) return localStorageData(id);
        const body = (await apiGet(`/me/plugins/storage?plugin=${encodeURIComponent(id)}`)) as {
          data: Record<string, unknown>;
        };
        return body.data;
      },
      storageSet: async (key, value) => {
        const id = latest.current.plugin.plugin.id;
        if (!settingsSnapshot().signedIn) {
          const data = localStorageData(id);
          if (value === null) delete data[key];
          else data[key] = value;
          const text = JSON.stringify(data);
          if (text.length > MAX_STORAGE_BYTES) throw new HostError('InvalidParams', 'storage is full (64 KB)');
          try {
            localStorage.setItem(localStorageKey(id), text);
          } catch {
            throw new HostError('Unavailable', "this browser won't keep it");
          }
          return;
        }
        const res = await fetch('/api/v1/me/plugins/storage', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: id, key, value }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new HostError('InvalidParams', body?.error?.message ?? `HTTP ${res.status}`);
        }
      },
      api: apiGet,
      apiLines,
      setHeight: (h) => setHeight(Math.max(0, h)),
      openUrl: (url) => {
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    };

    function onMessage(event: MessageEvent) {
      if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data as { type?: unknown; protocol?: unknown } | null;
      if (data?.type !== HELLO_MESSAGE || data.protocol !== PROTOCOL_VERSION) return;
      // A hello after boot is the frame's page loading again: it gets a new port.
      connection?.close();
      const channel = new MessageChannel();
      connection = connect(channel.port1, services);
      connectionRef.current = connection;
      frame.contentWindow!.postMessage(
        { type: BOOT_MESSAGE, protocol: PROTOCOL_VERSION, apiVersion: API_VERSION, context: context() },
        origin,
        [channel.port2],
      );
      latest.current.onConnect?.(connection);
    }
    window.addEventListener('message', onMessage);

    // Tell the frame when its settings or the theme change.
    let lastSettings = JSON.stringify(pluginSettings(latest.current.plugin));
    const stopSettings = subscribeSettings(() => {
      const next = pluginSettings(latest.current.plugin);
      const text = JSON.stringify(next);
      if (text === lastSettings) return;
      lastSettings = text;
      connection?.emit('settings.change', next);
    });
    let lastTheme = JSON.stringify(readTheme());
    const themeChanged = () => {
      const theme = readTheme();
      const text = JSON.stringify(theme);
      if (text === lastTheme) return;
      lastTheme = text;
      connection?.emit('theme.change', theme);
    };
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', themeChanged);
    const observer = new MutationObserver(themeChanged);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

    frame.src = src;
    return () => {
      window.removeEventListener('message', onMessage);
      stopSettings();
      media.removeEventListener('change', themeChanged);
      observer.disconnect();
      connection?.close();
      connectionRef.current = null;
      latest.current.onConnect?.(null);
    };
  }, [started, src, origin]);

  // The reader signing in or out, or becoming the page's owner: the frame's context changes.
  const viewerKey = `${viewer.signedIn}/${viewer.isOwner}`;
  const lastViewer = useRef(viewerKey);
  useEffect(() => {
    if (lastViewer.current === viewerKey) return;
    lastViewer.current = viewerKey;
    connectionRef.current?.emit('context.change', frameContext(latest.current));
  }, [viewerKey]);

  return (
    <iframe
      ref={frameRef}
      title={title}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}
