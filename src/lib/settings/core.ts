import { z } from 'zod';
import { HIDE_UNTIL, type HideUntil } from '../scope-stats';
import { KINDS } from '../kinds';
import { PAGE_PANELS, PANEL_KINDS, panelIds, SLOT_TITLES, type PanelKind } from '../panels';
import { PLUGIN_PANEL_ID_RE } from '../plugins/manifest';
import { parsePluginSource, sourceKey } from '../plugins/sources';
import { PLUGIN_ID_RE } from './spec';
import { USER_SHOW, USER_SHOW_ITEMS, userShowKey } from '../user-pages';

/**
 * The site's own settings: one entry per key, with its schema, default and description. The settings form, the
 * JSON Schema at `/schemas/settings.json` and the validator are all made from this list.
 *
 * Add a key only when something reads it. Settings are **preferences**; what the site merely remembers (dismissed
 * prompts, caches) is state and stays out of settings.json, as VS Code keeps it out of its own.
 */
export interface CoreSetting<T = unknown> {
  /** Checks a value strictly, as a PUT does. Also the source of the key's JSON Schema. */
  schema: z.ZodType<T>;
  default: T;
  /** The form's label. */
  title: string;
  description: string;
  /** Which settings group the form puts it under. */
  group: string;
  /**
   * Reads a stored value leniently: the part of it that still means something, or `undefined` for "use the layer
   * below". Without one, a value reads only if `schema` accepts it whole.
   */
  sanitize?: (raw: unknown) => T | undefined;
  /**
   * How the form draws it: a list of choices as `toggles` (a box each) or `order` (a list to arrange); a boolean as a
   * `switch` (one box).
   */
  widget?: 'toggles' | 'order' | 'switch';
  /** The choices of a list setting, with their labels, for the form. */
  choices?: { value: string; label: string; group?: string }[];
  /**
   * Read from the site layer only: what admins decide for everyone (`plugins.default`, `plugins.blocked`). A user's
   * file may name it, with a warning, and it changes nothing.
   */
  siteOnly?: boolean;
  /**
   * Read from the user layer only: what only the account itself may decide, such as what its public page shows
   * (`user.show.*`). A site file may name it, with a warning, and it changes nothing, so no admin can publish
   * everyone's real names by changing a default.
   */
  accountOnly?: boolean;
  /** Shown in the form only to a signed-in reader: it is about the account (`user.show.*`). */
  signedInOnly?: boolean;
}

/**
 * A list of a kind's panel ids, unique: built-in ones (`lib/panels.ts`) and plugins' (`<plugin id>.<panel id>`,
 * whichever plugins are installed). Read leniently: built-in ids that no longer exist are dropped.
 */
function panelList(
  kind: PanelKind,
  widget: 'toggles' | 'order',
  title: string,
  description: string,
): CoreSetting<string[]> {
  const ids = panelIds(kind);
  return {
    schema: z
      .array(
        z.union([
          z.enum(ids as [string, ...string[]]),
          z.string().regex(PLUGIN_PANEL_ID_RE, "a built-in panel's id, or a plugin's as <plugin id>.<panel id>"),
        ]),
      )
      .refine((list) => new Set(list).size === list.length, 'must not name a panel twice'),
    default: [],
    title,
    description,
    group: `${KINDS[kind].title} pages`,
    widget,
    choices: PAGE_PANELS[kind].map((p) => ({ value: p.id, label: p.title, group: SLOT_TITLES[p.slot] ?? p.slot })),
    sanitize: (raw) => {
      if (!Array.isArray(raw)) return undefined;
      return [
        ...new Set(
          raw.filter((id): id is string => typeof id === 'string' && (ids.includes(id) || PLUGIN_PANEL_ID_RE.test(id))),
        ),
      ];
    },
  };
}

function kindSettings(kind: PanelKind): Record<string, CoreSetting> {
  const noun = `${kind} pages`;
  return {
    [`${kind}.panels.hidden`]: panelList(
      kind,
      'toggles',
      'Hidden panels',
      `Built-in panels to leave off ${noun}, by id.`,
    ) as CoreSetting,
    [`${kind}.panels.order`]: panelList(
      kind,
      'order',
      'Panel order',
      `Panels to show first on ${noun}, in this order, each within its own part of the page; the rest follow in their usual order.`,
    ) as CoreSetting,
  };
}

/** An installed plugin, in settings.json's `plugins` key: whether it runs, and the tag, branch or commit to run. */
export interface PluginEntry {
  enabled: boolean;
  /** A tag, branch or commit; absent for the default branch (or a dev source, which is never pinned). */
  ref?: string;
}

const pluginEntrySchema = z.strictObject({
  enabled: z.boolean().default(true),
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_.\/-]{1,200}$/)
    .optional(),
});

/**
 * Read a `plugins` value leniently, as Presio's `sanitizePluginList`: entries whose source reads, keyed canonically
 * (`lib/plugins/sources.ts`), each with `enabled` (default true) and its `ref`; a ref written in the key
 * (`github:a/b@v1`) counts when the entry has none. Anything else is dropped.
 */
export function sanitizePlugins(raw: unknown): Record<string, PluginEntry> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, PluginEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    const source = parsePluginSource(key);
    if (!source || source.kind !== 'github') continue;
    const entry = pluginEntrySchema.safeParse(value ?? {});
    if (!entry.success) continue;
    const ref = entry.data.ref ?? source.ref ?? undefined;
    out[sourceKey(source)] = { enabled: entry.data.enabled, ...(ref ? { ref } : {}) };
  }
  return out;
}

const githubSource = z.string().refine((text) => parsePluginSource(text)?.kind === 'github', {
  message: 'a plugin source: github:<owner>/<repo>[/<folder>][@<ref>]',
});

const PLUGIN_SETTINGS: Record<string, CoreSetting> = {
  plugins: {
    schema: z.record(githubSource, pluginEntrySchema) as z.ZodType,
    default: {},
    title: 'Plugins',
    description:
      'Installed plugins, by source ("github:<owner>/<repo>[/<folder>]"), each { "enabled": true|false, "ref": "<tag, branch or commit>" }. A plugin runs once you approve its permissions on a page.',
    group: 'Plugins',
    sanitize: sanitizePlugins,
  },
  'plugins.default': {
    schema: z.array(githubSource).max(50) as z.ZodType,
    default: [],
    title: 'Plugins for everyone',
    description:
      'Set by the site: plugin sources ("github:<owner>/<repo>[@<ref>]") installed for every reader, who can turn one off in their own "plugins".',
    group: 'Plugins',
    siteOnly: true,
    sanitize: (raw) =>
      Array.isArray(raw)
        ? raw.filter((s): s is string => typeof s === 'string' && parsePluginSource(s)?.kind === 'github')
        : undefined,
  },
  'plugins.blocked': {
    schema: z
      .array(
        z
          .string()
          .regex(
            new RegExp(`^${PLUGIN_ID_RE.source.slice(1, -1)}(@[0-9a-f]{40})?$`),
            'a plugin id, or <plugin id>@<commit>',
          ),
      )
      .max(500) as z.ZodType,
    default: [],
    title: 'Blocked plugins',
    description:
      'Set by the site: plugin ids ("<owner>/<name>"), or ids at one commit ("<owner>/<name>@<commit>"), that never run, for anyone.',
    group: 'Plugins',
    siteOnly: true,
    sanitize: (raw) => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : undefined),
  },
  'plugins.venueStats.hideUntil': {
    schema: z.enum(HIDE_UNTIL) as z.ZodType,
    default: 'never',
    title: 'Hide venue statistics until',
    description:
      'Set by the site: "never" serves a venue\'s score statistics (GET /api/v1/pages/{identifier}/scores, scope.scores) as soon as there are reviews; "decisions" withholds them until the venue has decided on a submission, so nothing states a paper\'s rank while reviews are open.',
    group: 'Plugins',
    siteOnly: true,
    sanitize: (raw) => (HIDE_UNTIL.includes(raw as HideUntil) ? raw : undefined),
  },
};

/** What the account's public page shows (`lib/user-pages.ts`): one switch per item, the account's own choice. */
export const USER_PAGE_GROUP = 'Your public page';
const USER_SETTINGS: Record<string, CoreSetting> = Object.fromEntries(
  USER_SHOW_ITEMS.map((item): [string, CoreSetting] => [
    userShowKey(item),
    {
      schema: z.boolean() as z.ZodType,
      default: USER_SHOW[item].default,
      title: USER_SHOW[item].title,
      description: USER_SHOW[item].description,
      group: USER_PAGE_GROUP,
      widget: 'switch',
      accountOnly: true,
      signedInOnly: true,
    },
  ]),
);

export const CORE_SETTINGS: Record<string, CoreSetting> = {
  ...Object.fromEntries(PANEL_KINDS.flatMap((kind) => Object.entries(kindSettings(kind)))),
  ...USER_SETTINGS,
  ...PLUGIN_SETTINGS,
};

export type CoreSettingKey = keyof typeof CORE_SETTINGS & string;

export function isCoreSetting(key: string): boolean {
  return Object.hasOwn(CORE_SETTINGS, key);
}

/** A stored value as its setting reads it, or `undefined` for "use the layer below". */
export function readCoreValue(setting: CoreSetting, raw: unknown): unknown {
  if (setting.sanitize) return setting.sanitize(raw);
  const parsed = setting.schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
