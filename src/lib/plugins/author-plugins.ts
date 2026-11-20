import { z } from 'zod';
import { PLUGIN_PANEL_ID_RE } from './manifest';

/**
 * `owners/plugins.json`: the plugins' panels a paper's authors let into its author section (`paper.author`). Only
 * confirmed authors write under `owners/` (`server/pages/rules.ts`), so only they decide. Listing a panel installs
 * nothing: a reader sees it only if they have the plugin installed and running, and the panel's manifest offers the
 * author section (`"slot": { "paper": "author" }`). What it may read there is what it may read anywhere; nothing a
 * plugin does writes to the page. Each entry's `settings` reach the frame as `pp.context.surface.config`, so the
 * authors can say what it shows for their paper.
 */
export const AUTHOR_PLUGINS_PATH = 'owners/plugins.json';
export const MAX_AUTHOR_PANELS = 8;
/** Of one entry's settings, as JSON. */
export const MAX_AUTHOR_CONFIG_BYTES = 4096;

export const authorPluginsFileSchema = z
  .strictObject({
    panels: z
      .array(
        z.strictObject({
          panel: z
            .string()
            .regex(PLUGIN_PANEL_ID_RE, 'a plugin panel, as <owner>/<name>.<panel id>')
            .meta({ description: 'The panel, as `<plugin id>.<panel id>`: "benedict-armstrong/paper-map.minimap".' }),
          settings: z
            .record(z.string(), z.unknown())
            .optional()
            .refine((v) => v === undefined || JSON.stringify(v).length <= MAX_AUTHOR_CONFIG_BYTES, {
              message: `is larger than ${MAX_AUTHOR_CONFIG_BYTES} bytes`,
            })
            .meta({ description: "What the panel shows on this paper, as the plugin's documentation says." }),
        }),
      )
      .max(MAX_AUTHOR_PANELS)
      .refine((list) => new Set(list.map((p) => p.panel)).size === list.length, 'names a panel twice')
      .meta({ description: 'The panels, in the order they show.' }),
  })
  .meta({
    title: 'Author section plugins',
    description:
      "The plugins' panels this paper's authors let into its author section. Readers see one only if they have its plugin installed.",
  });

export interface AuthorPanel {
  /** `<plugin id>.<panel id>`. */
  panel: string;
  settings?: Record<string, unknown>;
}

/** The file's panels, or the reason it isn't one. */
export function parseAuthorPlugins(text: string): { panels: AuthorPanel[] } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'is not valid JSON' };
  }
  const parsed = authorPluginsFileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      problem: `is not { "panels": [{ "panel": "<plugin id>.<panel id>" }] }: ${issue.path.join('.') || 'it'}: ${issue.message}`,
    };
  }
  return { panels: parsed.data.panels };
}
