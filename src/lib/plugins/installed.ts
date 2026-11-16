import type { PluginEntry } from '../settings/core';
import type { ResolvedSettings } from '../settings/document';
import { parsePluginSource, sourceKey } from './sources';
import type { PageKind } from '../kinds';
import { SLOT_TITLES } from '../panels';
import { kindSlot, panelSlot, pluginPanelId, type PluginManifest, type PluginPermission } from './manifest';

/**
 * Which plugins a reader has installed, from their resolved settings (DESIGN.md §10): the site's `plugins.default`
 * (installed for everyone, at the site's ref), then the reader's own `plugins`, which can turn a default off, pin it
 * to another ref, or add plugins of their own. `plugins.blocked` (site only) stops a plugin, or one commit of it, for
 * everyone. Pure, shared by the server and the browser.
 */

export interface InstalledEntry {
  /** The source's key (`lib/plugins/sources.ts`). */
  source: string;
  /** A tag, branch or commit; `null` for the default branch. */
  ref: string | null;
  enabled: boolean;
  /**
   * `site`: a `plugins.default` the reader left at the site's ref, which runs with the permissions its manifest asks
   * for (the admin who added it is the one who approved it). `user`: one the reader added or re-pinned, which runs
   * once they approve it.
   */
  from: 'site' | 'user';
}

export function installedEntries(values: ResolvedSettings): InstalledEntry[] {
  const own = (values.plugins ?? {}) as Record<string, PluginEntry>;
  const out = new Map<string, InstalledEntry>();
  for (const text of (values['plugins.default'] ?? []) as string[]) {
    const source = parsePluginSource(text);
    if (source?.kind !== 'github') continue;
    out.set(sourceKey(source), { source: sourceKey(source), ref: source.ref, enabled: true, from: 'site' });
  }
  for (const [key, entry] of Object.entries(own)) {
    const site = out.get(key);
    const ref = entry.ref ?? null;
    if (site && (ref === null || ref === site.ref)) {
      out.set(key, { ...site, enabled: entry.enabled });
    } else {
      out.set(key, { source: key, ref, enabled: entry.enabled, from: 'user' });
    }
  }
  return [...out.values()];
}

/** Whether `plugins.blocked` stops this plugin at this commit: by its id, or by `<id>@<commit>`. */
export function isBlocked(blocked: readonly string[], pluginId: string, commit: string | null): boolean {
  return blocked.includes(pluginId) || (commit !== null && blocked.includes(`${pluginId}@${commit}`));
}

export interface Grant {
  permissions: string[];
  network: string[];
}

/** What a manifest asks for that a grant doesn't give: empty lists mean it may run. */
export function missingConsent(
  manifest: Pick<PluginManifest, 'permissions' | 'network'>,
  grant: Grant | null,
): { permissions: PluginPermission[]; network: string[] } {
  return {
    permissions: manifest.permissions.filter((p) => !grant?.permissions.includes(p)),
    network: manifest.network.filter((origin) => !grant?.network.includes(origin)),
  };
}

/** A plugin as the page that runs it sees it (`GET /api/v1/plugins/installed`). */
export interface InstalledPlugin {
  source: string;
  ref: string | null;
  enabled: boolean;
  from: 'site' | 'user' | 'dev';
  /**
   * `ready`: runs. `consent`: waits for the reader to approve what `missing` lists. `blocked`: the site stopped it.
   * `disabled`: turned off. `error`: it couldn't be copied, or its manifest has errors (`error` says why).
   */
  status: 'ready' | 'consent' | 'blocked' | 'disabled' | 'error';
  error?: string;
  plugin: {
    id: string;
    commit: string | null;
    /** Its folder on GitHub at that commit, or the dev server's. */
    sourceUrl: string;
    /** Its files' folder, `<origin>/<commit>/`. */
    baseUrl: string;
    origin: string;
    manifest: PluginManifest;
  } | null;
  missing: { permissions: PluginPermission[]; network: string[] };
}

/**
 * Installed plugins' panels on a kind's pages, as choices for that kind's `<kind>.panels.hidden` and `.order` in the
 * settings form: each by `<plugin id>.<panel id>`, named with its plugin, grouped by the slot it takes there.
 */
export function pluginPanelChoices(
  plugins: readonly Pick<InstalledPlugin, 'plugin'>[],
  kind: PageKind,
): { value: string; label: string; group: string }[] {
  const out: { value: string; label: string; group: string }[] = [];
  const seen = new Set<string>();
  for (const { plugin } of plugins) {
    if (!plugin) continue;
    for (const panel of plugin.manifest.contributes.panels) {
      const slot = panelSlot(panel, kind);
      const value = pluginPanelId(plugin.id, panel.id);
      if (!slot || seen.has(value)) continue;
      seen.add(value);
      const at = kindSlot(kind, slot);
      out.push({ value, label: `${panel.title} (${plugin.manifest.name})`, group: SLOT_TITLES[at] ?? at });
    }
  }
  return out;
}
