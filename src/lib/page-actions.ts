import type { PageKind } from './kinds';
import { arrangePanels } from './panels';
import type { InstalledPlugin } from './plugins/installed';
import { whenHolds, type WhenContext } from './plugins/when';

/**
 * The actions under a page's title (`components/pages/PageActions.tsx`): the site's own (`PAGE_ACTIONS`) and those
 * installed plugins offer (`contributes.actions`, `<plugin id>.<action id>`). A reader hides (`<kind>.actions.hidden`)
 * or reorders (`<kind>.actions.order`) them for each kind of page in settings, as they do the navbar's links. The first `BAR_SIZE`
 * shown are in the bar; the rest are in its "⋯" menu.
 *
 * **Ids are stable.** They are what people's settings name.
 */
export interface ActionInfo {
  id: string;
  /** How the settings form names it. */
  title: string;
  /** The kinds of page it is on; every kind when absent. */
  kinds?: PageKind[];
}

export const PAGE_ACTIONS: ActionInfo[] = [
  { id: 'cite', title: 'cite', kinds: ['paper'] },
  { id: 'edit', title: 'edit' },
  { id: 'follow', title: 'follow', kinds: ['paper'] },
  { id: 'share', title: 'share' },
  { id: 'history', title: 'history' },
  { id: 'agents', title: 'for agents', kinds: ['paper'] },
];

/** The site's actions on a kind's pages. */
export function actionsOf(kind: PageKind): ActionInfo[] {
  return PAGE_ACTIONS.filter((a) => !a.kinds || a.kinds.includes(kind));
}

/** How many actions the bar shows before the rest go in its menu. */
export const BAR_SIZE = 4;

/** A plugin's action, for the bar and the settings form. */
export interface PluginAction {
  id: string;
  /** The action's own id within its plugin. */
  action: string;
  title: string;
  pluginId: string;
  /** The plugin, by name. */
  plugin: string;
}

/**
 * The actions installed plugins offer, once each: those whose plugin runs or waits for the reader's approval. With
 * `on`, only those for that kind of page, and with its `context`, only those whose `when` holds there.
 */
export function pluginActions(
  plugins: readonly Pick<InstalledPlugin, 'plugin' | 'status'>[],
  on?: { kind: PageKind; context?: WhenContext },
): PluginAction[] {
  const out: PluginAction[] = [];
  const seen = new Set<string>();
  for (const { plugin, status } of plugins) {
    if (!plugin || (status !== 'ready' && status !== 'consent')) continue;
    for (const action of plugin.manifest.contributes.actions ?? []) {
      const id = `${plugin.id}.${action.id}`;
      if (seen.has(id)) continue;
      if (on && !action.kinds.includes(on.kind)) continue;
      if (on?.context && !whenHolds(action.when, on.context)) continue;
      seen.add(id);
      out.push({ id, action: action.id, title: action.title, pluginId: plugin.id, plugin: plugin.manifest.name });
    }
  }
  return out;
}

/** The actions there are, arranged by the reader's settings: those in the bar, and those in its menu. */
export function arrangeActions(
  ids: readonly string[],
  hidden: readonly string[],
  order: readonly string[],
): { bar: string[]; menu: string[] } {
  const shown = arrangePanels(ids, hidden, order);
  return { bar: shown.slice(0, BAR_SIZE), menu: shown.slice(BAR_SIZE) };
}
