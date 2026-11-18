import { KINDS } from '../kinds';
import { PANEL_KINDS, type PanelKind } from '../panels';
import { CORE_SETTINGS, USER_PAGE_GROUP, type CoreSetting } from './core';
import { qualify, sanitizeSettingValue, settingTitle, type PluginSettingSpec } from './spec';

/**
 * The settings form's model, as VS Code's settings editor has one: settings in categories, each category a page of
 * `/settings`, each plugin's settings a page of their own, and each setting drawn by one of a few standard controls.
 * Core settings (`core.ts`) and plugins' (`spec.ts`) are both turned into `SettingItem`s here, so one form draws both.
 */

export interface Choice {
  value: string;
  label: string;
  /** A heading the control sets it under (a panel's part of the page). */
  group?: string;
  /** Can't be switched off (the navbar's link to settings). */
  locked?: boolean;
  /** The choice it is drawn under, as a sub-item (a plugin's panel under each submission). */
  parent?: string;
}

/** How a setting is drawn. */
export type Control =
  /** A switch: on or off. */
  | { kind: 'switch' }
  /** One of a few values: a dropdown, or a radio button each. */
  | { kind: 'select'; choices: Choice[]; display: 'dropdown' | 'radio' }
  | { kind: 'text'; multiline: boolean; maxLength?: number; placeholder?: string }
  | { kind: 'number'; minimum?: number; maximum?: number; nullable: boolean }
  /**
   * A list to add to, remove from and reorder. With `choices`, items are picked from them; without, typed.
   */
  | { kind: 'list'; choices?: Choice[]; maxItems?: number; maxLength?: number; placeholder?: string }
  /**
   * A box per choice. The value lists the ticked ones, or with `inverted` the unticked ones (a list of panels to
   * hide is drawn as the panels shown).
   */
  | { kind: 'checklist'; choices: Choice[]; inverted: boolean }
  /** A fixed set of choices to put in order; the value lists those moved first. */
  | {
      kind: 'rank';
      choices: Choice[];
      /**
       * A second setting the control edits: a list of the choices switched off, drawn as a switch on each row. The
       * setting's own key keeps the order; this one keeps what is hidden.
       */
      toggleKey?: string;
    }
  /** No control: set it in the file. */
  | { kind: 'file' };

export interface SettingItem {
  /** The settings.json key. */
  key: string;
  title: string;
  description: string;
  /** The category it is on: a core category's id, or `plugin:<plugin id>`. */
  category: string;
  /** A heading within its page. */
  group?: string;
  control: Control;
  /** Its value when the reader's file doesn't set it, if the layers below don't say. */
  fallback: unknown;
  /**
   * Reads the file's own value, for a setting the resolved values may lack (a plugin loaded from localhost, which
   * the server doesn't know): the value, or `undefined` when it doesn't fit.
   */
  read?: (raw: unknown) => unknown;
}

export interface Category {
  /** Its path under `/settings`. */
  id: string;
  title: string;
  description: string;
  /** Where the sidebar lists it. */
  section: 'Pages' | 'Account';
  /** Only for a signed-in reader: it is about the account. */
  signedInOnly?: boolean;
}

const KIND_CATEGORY: Record<PanelKind, string> = Object.fromEntries(
  PANEL_KINDS.map((kind) => [kind, kind === 'user' ? 'people' : kind]),
) as Record<PanelKind, string>;

const KIND_DESCRIPTION: Record<PanelKind, string> = {
  paper: "Which parts of a paper's page you see, and in what order.",
  venue: "Which parts of a venue's page you see, and in what order.",
  topic: "Which parts of a topic's page you see, and in what order.",
  org: "Which parts of an organisation's page you see, and in what order.",
  user: "Which parts of a person's page you see, and in what order.",
};

/** The core categories, in the sidebar's order. */
export const CATEGORIES: Category[] = [
  {
    id: 'navbar',
    title: 'Navbar',
    description: 'Which links the bar at the top shows, and in what order.',
    section: 'Pages',
  },
  ...PANEL_KINDS.map((kind): Category => ({
    id: KIND_CATEGORY[kind],
    title: kind === 'user' ? "People's pages" : `${KINDS[kind].title} pages`,
    description: KIND_DESCRIPTION[kind],
    section: 'Pages',
  })),
  {
    id: 'public-page',
    title: 'Your public page',
    description: 'What your own page shows to everyone. Your profile and institution are on your profile.',
    section: 'Account',
    signedInOnly: true,
  },
];

export function findCategory(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

/** The category of a core setting, or `null` for one the form doesn't show (the site's plugin keys). */
function coreCategory(key: string, setting: CoreSetting): string | null {
  if (setting.siteOnly || setting.group === 'Plugins') return null;
  if (setting.group === USER_PAGE_GROUP) return 'public-page';
  if (key.startsWith('navbar.')) return 'navbar';
  const kind = key.split('.')[0] as PanelKind;
  return PANEL_KINDS.includes(kind) ? KIND_CATEGORY[kind] : null;
}

function coreControl(setting: CoreSetting, extra: Choice[]): Control {
  const choices = [...(setting.choices ?? []), ...extra];
  switch (setting.widget) {
    case 'switch':
      return { kind: 'switch' };
    case 'toggles':
      return { kind: 'checklist', choices, inverted: true };
    case 'order':
      return { kind: 'rank', choices };
    default:
      return { kind: 'file' };
  }
}

/**
 * The list a setting arranges, for settings drawn as an order with a switch per item: `<kind>.panels` for a kind's
 * panels, `navbar` for the navbar's links. `null` for any other setting.
 */
export function arrangedList(key: string): string | null {
  const m = /^(.+)\.(order|hidden)$/.exec(key);
  if (!m) return null;
  const [, prefix] = m;
  if (prefix === 'navbar') return prefix;
  const kind = prefix.split('.')[0] as PanelKind;
  return PANEL_KINDS.includes(kind) && prefix === `${kind}.panels` ? prefix : null;
}

/**
 * The core settings the form shows, in order. `pluginChoices` adds installed plugins' items to an arranged list
 * (`arrangedList`): their panels to a kind's panels (`pluginPanelChoices`), their pages to the navbar.
 */
export function coreItems(pluginChoices: (list: string) => Choice[] = () => []): SettingItem[] {
  const out: SettingItem[] = [];
  for (const [key, setting] of Object.entries(CORE_SETTINGS)) {
    const category = coreCategory(key, setting);
    if (!category) continue;
    const list = setting.widget === undefined ? null : arrangedList(key);
    // An arranged list is one control: its order, with a switch per item for `<list>.hidden`. The two stay separate
    // keys in the file, flat lists anyone can edit by hand.
    if (list && setting.widget === 'toggles') continue;
    const control = coreControl(setting, list ? pluginChoices(list) : []);
    const pageTitle = findCategory(category)?.title.toLowerCase() ?? 'these pages';
    const arranged = list && control.kind === 'rank';
    out.push({
      key,
      title: !arranged ? setting.title : list === 'navbar' ? 'Links' : 'Panels',
      description: !arranged
        ? setting.description
        : list === 'navbar'
          ? 'Drag to reorder the links, and switch one off to leave it out.'
          : `Drag to reorder the panels within each part of ${pageTitle}, and switch one off to leave it out.`,
      category,
      control: arranged ? { ...control, toggleKey: `${list}.hidden` } : control,
      fallback: setting.default,
    });
  }
  return out;
}

/** Every key an item edits: its own, and its control's second one. */
export function itemKeys(item: SettingItem): string[] {
  return item.control.kind === 'rank' && item.control.toggleKey ? [item.key, item.control.toggleKey] : [item.key];
}

function specChoices(spec: { values: string[]; labels?: string[] }): Choice[] {
  return spec.values.map((value, i) => ({ value, label: spec.labels?.[i] ?? value }));
}

/** How a plugin's setting is drawn. */
export function specControl(spec: PluginSettingSpec): Control {
  switch (spec.type) {
    case 'boolean':
      return { kind: 'switch' };
    case 'number':
      return { kind: 'number', minimum: spec.minimum, maximum: spec.maximum, nullable: spec.default === null };
    case 'string':
      return {
        kind: 'text',
        multiline: spec.multiline === true,
        maxLength: spec.maxLength,
        placeholder: spec.placeholder,
      };
    case 'enum':
      return { kind: 'select', choices: specChoices(spec), display: spec.display ?? 'dropdown' };
    case 'list':
      return {
        kind: 'list',
        choices: spec.values ? specChoices({ values: spec.values, labels: spec.labels }) : undefined,
        maxItems: spec.maxItems,
        maxLength: spec.maxLength,
        placeholder: spec.placeholder,
      };
    case 'set':
      return { kind: 'checklist', choices: specChoices(spec), inverted: false };
  }
}

/** A plugin's settings, by their `order`, then as the manifest lists them. */
export function pluginItems(pluginId: string, specs: Record<string, PluginSettingSpec>): SettingItem[] {
  return Object.entries(specs)
    .map(([name, spec], i) => ({ name, spec, i }))
    .sort((a, b) => (a.spec.order ?? Infinity) - (b.spec.order ?? Infinity) || a.i - b.i)
    .map(({ name, spec }) => ({
      key: qualify(pluginId, name),
      title: settingTitle(name, spec),
      description: spec.description ?? '',
      category: pluginCategory(pluginId),
      group: spec.group,
      control: specControl(spec),
      fallback: spec.default,
      read: (raw: unknown) => sanitizeSettingValue(spec, raw),
    }));
}

export function pluginCategory(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/** A plugin's settings page. */
export function pluginSettingsPath(pluginId: string): string {
  return `/settings/plugins/${pluginId}`;
}

/** Whether an item matches every word of a search, in its title, description, key or category's name. */
export function matchesSearch(item: SettingItem, categoryTitle: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  const choices = 'choices' in item.control ? (item.control.choices ?? []).map((c) => c.label).join(' ') : '';
  const text =
    `${item.title} ${item.description} ${itemKeys(item).join(' ')} ${categoryTitle} ${choices}`.toLowerCase();
  return words.every((w) => text.includes(w));
}
