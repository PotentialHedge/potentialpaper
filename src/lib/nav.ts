import type { InstalledPlugin } from './plugins/installed';

/**
 * The navbar's links: the site's own (`NAV_ITEMS`) and those installed plugins offer (a page with `"nav"` in its
 * manifest, `<plugin id>.<page id>`). A reader hides (`navbar.hidden`) or reorders (`navbar.order`) them in settings,
 * as they do a page's panels (`lib/panels.ts`). The account link (`@handle`, or "sign in") always comes last.
 *
 * **Ids are stable.** They are what people's settings name.
 */
export interface NavItem {
  id: string;
  title: string;
  href: string;
  /** Only for a signed-in reader. */
  signedIn?: boolean;
  /** Can't be hidden: the way back to these settings. */
  locked?: boolean;
  /** The plugin that offers it, by name. */
  plugin?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { id: 'papers', title: 'my papers', href: '/papers', signedIn: true },
  { id: 'changes', title: 'changes', href: '/changes' },
  { id: 'settings', title: 'settings', href: '/settings', locked: true },
];

export const NAV_IDS = NAV_ITEMS.map((i) => i.id);
/** The ids a reader may hide. */
export const HIDEABLE_NAV_IDS = NAV_ITEMS.filter((i) => !i.locked).map((i) => i.id);

/** A plugin page's address. */
export function pluginPagePath(pluginId: string, pageId: string): string {
  return `/x/${pluginId}/${pageId}`;
}

/**
 * The navbar links installed plugins offer, once each: those whose plugin runs, or waits for the reader's approval
 * (its page asks for it).
 */
export function pluginNavItems(plugins: readonly Pick<InstalledPlugin, 'plugin' | 'status'>[]): NavItem[] {
  const out: NavItem[] = [];
  const seen = new Set<string>();
  for (const { plugin, status } of plugins) {
    if (!plugin || (status !== 'ready' && status !== 'consent')) continue;
    for (const page of plugin.manifest.contributes.pages) {
      if (!page.nav) continue;
      const id = `${plugin.id}.${page.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        title: typeof page.nav === 'string' ? page.nav : page.title,
        href: pluginPagePath(plugin.id, page.id),
        plugin: plugin.manifest.name,
      });
    }
  }
  return out;
}
