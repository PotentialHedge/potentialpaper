/**
 * How a plugin declares a setting, in its manifest's `contributes.settings`, and how a stored value is checked
 * against it. Ported from Presio (`shared/plugin/settings.ts`). The site's own settings are declared with zod
 * instead (`core.ts`), since they can be lists and need deeper checks; a plugin's are kept to these flat types,
 * which a settings form can draw without knowing the plugin.
 */

export type SettingSpec =
  | { type: 'boolean'; default: boolean; description?: string }
  | { type: 'number'; default: number | null; minimum?: number; maximum?: number; description?: string }
  | { type: 'string'; default: string; maxLength?: number; description?: string }
  | { type: 'enum'; default: string; values: string[]; labels?: string[]; description?: string };

/** What plugins may declare: every `SettingSpec` (Presio's `object` type isn't offered to plugins). */
export type PluginSettingSpec = SettingSpec;

/** A plugin's declared settings, by name, as the resolver and the schema need them. */
export interface PluginSettings {
  /** `<owner>/<name>`, as `handoffs/plugins.md` derives it from the plugin's source. */
  id: string;
  title?: string;
  settings: Record<string, PluginSettingSpec>;
}

/** The longest string a `string` setting holds when its spec sets no `maxLength`. */
export const DEFAULT_MAX_LENGTH = 1000;

/** Coerce a stored value to its spec, or `undefined` when it doesn't fit. */
export function sanitizeSettingValue(spec: SettingSpec, raw: unknown): unknown {
  switch (spec.type) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'number':
      if (raw === null && spec.default === null) return null;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
      if (spec.minimum !== undefined && raw < spec.minimum) return undefined;
      if (spec.maximum !== undefined && raw > spec.maximum) return undefined;
      return raw;
    case 'string':
      if (typeof raw !== 'string') return undefined;
      return raw.length <= (spec.maxLength ?? DEFAULT_MAX_LENGTH) ? raw : undefined;
    case 'enum':
      return typeof raw === 'string' && spec.values.includes(raw) ? raw : undefined;
  }
}

/** Why a value doesn't fit its spec, in words, for the validator's report. */
export function settingValueProblem(spec: SettingSpec, raw: unknown): string | null {
  if (sanitizeSettingValue(spec, raw) !== undefined) return null;
  switch (spec.type) {
    case 'boolean':
      return 'must be true or false';
    case 'number': {
      const range = [
        spec.minimum !== undefined ? `at least ${spec.minimum}` : null,
        spec.maximum !== undefined ? `at most ${spec.maximum}` : null,
      ].filter(Boolean);
      return `must be a number${range.length ? `, ${range.join(' and ')}` : ''}${spec.default === null ? ', or null' : ''}`;
    }
    case 'string':
      return typeof raw === 'string'
        ? `must be at most ${spec.maxLength ?? DEFAULT_MAX_LENGTH} characters`
        : 'must be a string';
    case 'enum':
      return `must be one of ${spec.values.map((v) => JSON.stringify(v)).join(', ')}`;
  }
}

const NAME = '[a-z0-9][a-z0-9-]{0,63}';
const OWNER = '[a-z0-9][a-z0-9-]{0,38}';

/** A plugin id, `<owner>/<name>`: a GitHub owner, lowercased, and a slug. */
export const PLUGIN_ID_RE = new RegExp(`^${OWNER}/${NAME}$`);
/** A plugin setting's name: no dots, so the last dot of a key splits it from the plugin id. */
export const SETTING_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A plugin's setting as a settings.json key: `<plugin id>.<name>`. */
export function qualify(pluginId: string, name: string): string {
  return `${pluginId}.${name}`;
}

/** A key's plugin id and setting name, or `null` for a key that isn't a plugin's (it has no `/`). */
export function splitQualified(key: string): { pluginId: string; name: string } | null {
  const dot = key.lastIndexOf('.');
  if (dot <= 0 || !key.slice(0, dot).includes('/')) return null;
  return { pluginId: key.slice(0, dot), name: key.slice(dot + 1) };
}
