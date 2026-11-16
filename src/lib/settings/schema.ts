import { z } from 'zod';
import { CORE_SETTINGS } from './core';
import { qualify, type PluginSettings, type SettingSpec } from './spec';

/**
 * The JSON Schema of a settings.json: the core keys and the given plugins' keys, so an editor can complete and
 * check it. Other keys are allowed: a file may name a plugin's settings before the plugin is installed.
 */
export function settingsJsonSchema(origin: string, plugins: PluginSettings[] = []): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(CORE_SETTINGS)) {
    const schema: Record<string, unknown> = { ...z.toJSONSchema(setting.schema, { unrepresentable: 'any' }) };
    delete schema.$schema;
    properties[key] = {
      ...schema,
      ...(Array.isArray(setting.default) ? { uniqueItems: true } : {}),
      title: setting.title,
      description: setting.description,
      default: setting.default,
    };
  }
  for (const plugin of plugins) {
    for (const [name, spec] of Object.entries(plugin.settings)) {
      properties[qualify(plugin.id, name)] = specSchema(spec, plugin);
    }
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${origin}/schemas/settings.json`,
    title: 'settings.json',
    description:
      'Your PotentialPaper settings. Keys are dotted; a plugin’s are "<plugin id>.<name>". The file holds only what differs from the site’s defaults. Comments are allowed.',
    type: 'object',
    // VS Code reads this, for JSONC.
    allowComments: true,
    allowTrailingCommas: true,
    properties,
    additionalProperties: true,
  };
}

function specSchema(spec: SettingSpec, plugin: PluginSettings): Record<string, unknown> {
  const common = {
    description: spec.description ? `${spec.description} (${plugin.title ?? plugin.id})` : (plugin.title ?? plugin.id),
    default: spec.default,
  };
  switch (spec.type) {
    case 'boolean':
      return { type: 'boolean', ...common };
    case 'number':
      return {
        type: spec.default === null ? ['number', 'null'] : 'number',
        ...(spec.minimum !== undefined && { minimum: spec.minimum }),
        ...(spec.maximum !== undefined && { maximum: spec.maximum }),
        ...common,
      };
    case 'string':
      return { type: 'string', maxLength: spec.maxLength ?? 1000, ...common };
    case 'enum':
      return {
        type: 'string',
        enum: spec.values,
        ...(spec.labels && { enumDescriptions: spec.labels }),
        ...common,
      };
  }
}
