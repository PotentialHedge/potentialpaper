import { z } from 'zod';
import { PAGE_PANELS, PANEL_KINDS, panelIds, type PanelKind } from '../panels';

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
  /** How the form draws a list of choices: `toggles` (a box each) or `order` (a list to arrange). */
  widget?: 'toggles' | 'order';
  /** The choices of a list setting, with their labels, for the form. */
  choices?: { value: string; label: string }[];
}

/** A list of a kind's panel ids, unique. Read leniently: ids that no longer exist are dropped. */
function panelList(
  kind: PanelKind,
  widget: 'toggles' | 'order',
  title: string,
  description: string,
): CoreSetting<string[]> {
  const ids = panelIds(kind);
  return {
    schema: z
      .array(z.enum(ids as [string, ...string[]]))
      .refine((list) => new Set(list).size === list.length, 'must not name a panel twice'),
    default: [],
    title,
    description,
    group: `${kind[0].toUpperCase()}${kind.slice(1)} pages`,
    widget,
    choices: PAGE_PANELS[kind].map((p) => ({ value: p.id, label: p.title })),
    sanitize: (raw) => {
      if (!Array.isArray(raw)) return undefined;
      return [...new Set(raw.filter((id): id is string => typeof id === 'string' && ids.includes(id)))];
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

export const CORE_SETTINGS: Record<string, CoreSetting> = Object.fromEntries(
  PANEL_KINDS.flatMap((kind) => Object.entries(kindSettings(kind))),
);

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
