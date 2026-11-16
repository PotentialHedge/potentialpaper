import { z } from 'zod';
import { KINDS, PAGE_KINDS, type PageKind } from '../kinds';
import { PLUGIN_ID_RE, sanitizeSettingValue, SETTING_NAME_RE, type PluginSettingSpec } from '../settings/spec';
import { MANIFEST_FILE } from './sources';
import { MAX_WHEN_LENGTH, whenKeys, parseWhen, whenProblem } from './when';

/**
 * A plugin's manifest, `potentialpaper-plugin.json` at the top of its folder (`handoffs/plugins.md` Phase 2, DESIGN.md
 * §10): what the plugin is, what it may do and what it adds. A plugin never touches the site's own interface. It
 * declares panels, pages, settings and commands, and the host draws them; its code runs in frames on an origin of
 * its own and reaches the site only through the RPC (`protocol.ts`).
 *
 * The validator reports every problem in one pass, each on one line naming its field
 * (`contributes.panels[0].slot: …`). Fields it doesn't know are warnings, not errors, so a newer manifest still
 * loads on an older host. Its JSON Schema is served at `/schemas/plugin-manifest.json`. Pure, shared by the server
 * (which checks a manifest when it copies a plugin) and the browser (which checks a dev server's).
 */

/** The plugin API's major version, which a manifest's `apiVersion` names. Additive changes keep it. */
export const API_VERSION = 1;

/**
 * What a plugin may ask for, and how the consent prompt says it. Every call that needs one is checked against what
 * the reader granted (`host.ts`). Data a plugin reads is the site's public data; the permissions say what a plugin
 * takes an interest in, so a reader knows before running it.
 */
export const PERMISSIONS = {
  'page.read': "Read the page it is on: its sections, links and kind file (a venue's venue.json, …)",
  'scope.read': 'List the papers of venues, topics and organisations',
  'reviews.read': "Read papers' submissions, reviews and decisions",
} as const;
export type PluginPermission = keyof typeof PERMISSIONS;
export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as PluginPermission[];

/** Where on a page of a kind a panel goes: its kind's `<kind>.main`, `<kind>.aside` or `<kind>.tabs`. */
export const PANEL_SLOTS = ['main', 'aside', 'tab'] as const;
export type PanelSlot = (typeof PANEL_SLOTS)[number];

/** The kind's slot a panel's `slot` names: `tab` is the kind's `tabs`. */
export function kindSlot(kind: PageKind, slot: PanelSlot): string {
  return `${kind}.${slot === 'tab' ? 'tabs' : slot}`;
}

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]{0,39}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** An origin a plugin's own backend lives at: https, a host, perhaps a port, and nothing after. */
const NETWORK_ORIGIN = /^https:\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;
/** A path in the plugin's folder: no scheme, no leading slash, no `..`. */
const RELATIVE_PATH = /^(?![a-z]+:)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,200}$/i;

const text = (max: number, description: string) => z.string().trim().min(1).max(max).meta({ description });
const contributionId = (what: string) =>
  z
    .string()
    .regex(CONTRIBUTION_ID, `a ${what}'s id is lower-case letters, digits and dashes, starting with a letter`)
    .meta({ description: `The ${what}'s id, unique in the plugin. Stable: settings name it.` });

const settingSpecSchema = z
  .discriminatedUnion('type', [
    z.looseObject({
      type: z.literal('boolean'),
      default: z.boolean(),
      description: text(300, 'What it does, for the settings form.').optional(),
    }),
    z.looseObject({
      type: z.literal('number'),
      default: z.number().nullable(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      description: text(300, 'What it does, for the settings form.').optional(),
    }),
    z.looseObject({
      type: z.literal('string'),
      default: z.string(),
      maxLength: z.number().int().min(1).max(1000).optional(),
      description: text(300, 'What it does, for the settings form.').optional(),
    }),
    z.looseObject({
      type: z.literal('enum'),
      default: z.string(),
      values: z.array(z.string().min(1).max(100)).min(1).max(50),
      labels: z.array(z.string().max(100)).optional(),
      description: text(300, 'What it does, for the settings form.').optional(),
    }),
  ])
  .meta({ description: 'A setting: its type, its default and what it does.' });

const kindsSchema = z
  .array(z.enum(PAGE_KINDS))
  .min(1)
  .max(PAGE_KINDS.length)
  .meta({ description: `The kinds of page it goes on: ${PAGE_KINDS.join(', ')}.` });

const slotSchema = z
  .union([z.enum(PANEL_SLOTS), z.partialRecord(z.enum([...PAGE_KINDS, '*']), z.enum(PANEL_SLOTS))])
  .meta({
    description:
      'Where it goes on each kind of page: "main", "aside" or "tab". One for every kind, or by kind with "*" for the rest: { "paper": "aside", "*": "main" }.',
  });

const panelSchema = z.looseObject({
  id: contributionId('panel'),
  title: text(60, 'Its heading, and its name in settings.'),
  kinds: kindsSchema,
  slot: slotSchema,
  when: z.string().max(MAX_WHEN_LENGTH).optional().meta({
    description:
      'Whether it shows on a page at all, as a condition on the page: "page.hasScores", "page.kind == venue && signedIn".',
  }),
});

const pageSchema = z.looseObject({
  id: contributionId('page'),
  title: text(60, "The page's title."),
});

const commandSchema = z.looseObject({
  id: contributionId('command'),
  title: text(60, 'What it does, as its menu entry says it: "Copy as CSV".'),
});

export const manifestSchema = z
  .looseObject({
    $schema: z.string().optional(),
    id: z
      .string()
      .regex(PLUGIN_ID_RE, 'a plugin id is "<GitHub owner>/<name>", lower-case, the name a slug')
      .meta({ description: 'The plugin\'s id, "<GitHub owner>/<name>", lower-case. The owner is the repo\'s.' }),
    name: text(80, 'Its name, as people see it.'),
    version: z
      .string()
      .regex(SEMVER, 'a semver version, like "1.0.0", without a "v"')
      .meta({ description: 'Its version, semver: tag the release "v" + version.' }),
    apiVersion: z
      .literal(API_VERSION)
      .meta({ description: `The plugin API's major version it is written for: ${API_VERSION}.` }),
    description: text(300, 'What it does, in a sentence.').optional(),
    author: text(80, 'Who made it.').optional(),
    homepage: z
      .url({ protocol: /^https$/ })
      .max(300)
      .optional()
      .meta({ description: 'Its home page.' }),
    main: z
      .string()
      .regex(RELATIVE_PATH, 'a path in the plugin\'s folder, like "dist/index.html"')
      .refine((path) => /\.html?$/i.test(path), 'must be an HTML file')
      .meta({ description: 'The HTML file every frame of the plugin loads, relative to the manifest.' }),
    permissions: z
      .array(z.enum(PERMISSION_NAMES as [PluginPermission, ...PluginPermission[]]))
      .max(PERMISSION_NAMES.length)
      .default([])
      .meta({ description: `What it may read through the RPC: ${PERMISSION_NAMES.join(', ')}.` }),
    network: z
      .array(z.string().regex(NETWORK_ORIGIN, 'an https origin, like "https://api.example.org", with no path'))
      .max(10)
      .default([])
      .meta({ description: 'Origins its own backend lives at, which its frames may connect to. https only.' }),
    contributes: z
      .looseObject({
        panels: z.array(panelSchema).max(8).default([]).meta({ description: 'Panels on pages, each a frame.' }),
        pages: z
          .array(pageSchema)
          .max(8)
          .default([])
          .meta({ description: 'Whole pages of its own, at /x/<plugin id>/<page id>.' }),
        settings: z
          .record(z.string().regex(SETTING_NAME_RE, 'a setting name starts with a letter; no dots'), settingSpecSchema)
          .default({})
          .meta({ description: 'Its settings, in settings.json as "<plugin id>.<name>".' }),
        commands: z
          .array(commandSchema)
          .max(16)
          .default([])
          .meta({ description: "Commands, listed in each of its panels' menus." }),
      })
      .default({ panels: [], pages: [], settings: {}, commands: [] }),
  })
  .meta({
    title: MANIFEST_FILE,
    description: 'A PotentialPaper plugin: what it is, what it may do and what it adds.',
  });

export interface PanelContribution {
  id: string;
  title: string;
  kinds: PageKind[];
  /** One slot for every kind, or one per kind (`'*'` for the rest). */
  slot: PanelSlot | Partial<Record<PageKind | '*', PanelSlot>>;
  when?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: typeof API_VERSION;
  description?: string;
  author?: string;
  homepage?: string;
  main: string;
  permissions: PluginPermission[];
  network: string[];
  contributes: {
    panels: PanelContribution[];
    pages: { id: string; title: string }[];
    settings: Record<string, PluginSettingSpec>;
    commands: { id: string; title: string }[];
  };
}

export interface ManifestReport {
  /** Set when there are no errors. */
  manifest: PluginManifest | null;
  errors: string[];
  warnings: string[];
}

/** `contributes.panels[0].slot`, from a zod issue's path. */
function pathText(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fields the schema doesn't name, as warnings: the manifest may be for a newer host. */
function unknownFields(raw: Record<string, unknown>, warn: (path: string, message: string) => void) {
  const check = (obj: unknown, known: readonly string[], at: string) => {
    if (!isObject(obj)) return;
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) warn(at ? `${at}.${key}` : key, 'not a field this site knows; ignored');
    }
  };
  check(raw, Object.keys(manifestSchema.shape), '');
  const contributes = raw.contributes;
  check(contributes, ['panels', 'pages', 'settings', 'commands'], 'contributes');
  if (!isObject(contributes)) return;
  const each = (list: unknown, known: string[], at: string) =>
    Array.isArray(list) && list.forEach((item, i) => check(item, known, `${at}[${i}]`));
  each(contributes.panels, Object.keys(panelSchema.shape), 'contributes.panels');
  each(contributes.pages, Object.keys(pageSchema.shape), 'contributes.pages');
  each(contributes.commands, Object.keys(commandSchema.shape), 'contributes.commands');
  if (isObject(contributes.settings)) {
    const fields: Record<string, string[]> = {
      boolean: ['type', 'default', 'description'],
      number: ['type', 'default', 'minimum', 'maximum', 'description'],
      string: ['type', 'default', 'maxLength', 'description'],
      enum: ['type', 'default', 'values', 'labels', 'description'],
    };
    for (const [name, spec] of Object.entries(contributes.settings)) {
      if (isObject(spec) && typeof spec.type === 'string' && fields[spec.type]) {
        check(spec, fields[spec.type], `contributes.settings.${name}`);
      }
    }
  }
}

/** Which slot a panel takes on a page of a kind, or `null` if it doesn't go on that kind. */
export function panelSlot(panel: Pick<PanelContribution, 'kinds' | 'slot'>, kind: PageKind): PanelSlot | null {
  if (!panel.kinds.includes(kind)) return null;
  if (typeof panel.slot === 'string') return panel.slot;
  return panel.slot[kind] ?? panel.slot['*'] ?? null;
}

/** Checks the schema can't: ids unique, slots for every kind, conditions that parse, defaults that fit. */
function crossChecks(
  manifest: PluginManifest,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
) {
  const { panels, pages, settings, commands } = manifest.contributes;
  const unique = (list: { id: string }[], at: string, what: string) => {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      if (seen.has(item.id)) error(`${at}[${i}].id`, `a second ${what} "${item.id}"`);
      seen.add(item.id);
    });
  };
  unique(panels, 'contributes.panels', 'panel');
  unique(pages, 'contributes.pages', 'page');
  unique(commands, 'contributes.commands', 'command');

  panels.forEach((panel, i) => {
    const at = `contributes.panels[${i}]`;
    if (new Set(panel.kinds).size !== panel.kinds.length) warn(`${at}.kinds`, 'names a kind twice');
    for (const kind of panel.kinds) {
      const slot = panelSlot(panel, kind);
      if (!slot) {
        error(`${at}.slot`, `says nothing for ${kind} pages; add "${kind}" or "*"`);
      } else if (!KINDS[kind].slots.includes(kindSlot(kind, slot))) {
        error(`${at}.slot`, `${kind} pages have no "${slot}" slot`);
      }
    }
    if (typeof panel.slot === 'object') {
      for (const key of Object.keys(panel.slot)) {
        if (key !== '*' && !panel.kinds.includes(key as PageKind)) {
          warn(`${at}.slot.${key}`, `the panel isn't on ${key} pages (see "kinds")`);
        }
      }
    }
    if (panel.when !== undefined) {
      const problem = whenProblem(panel.when);
      if (problem) {
        error(`${at}.when`, problem);
      } else {
        const keys = whenKeys(parseWhen(panel.when));
        for (const kind of panel.kinds) {
          const missing = keys.filter((key) => !KINDS[kind].contextKeys.includes(key));
          if (missing.length) {
            warn(`${at}.when`, `${kind} pages don't offer ${missing.join(', ')}, which read as false there`);
          }
        }
      }
    }
  });

  for (const [name, spec] of Object.entries(settings)) {
    const at = `contributes.settings.${name}`;
    if (spec.type === 'enum' && spec.labels && spec.labels.length !== spec.values.length) {
      error(`${at}.labels`, `needs ${spec.values.length} labels, one per value`);
    }
    if (
      spec.type === 'number' &&
      spec.minimum !== undefined &&
      spec.maximum !== undefined &&
      spec.minimum > spec.maximum
    ) {
      error(at, 'its minimum is above its maximum');
    }
    if (sanitizeSettingValue(spec, spec.default) === undefined) {
      error(`${at}.default`, `${JSON.stringify(spec.default)} doesn't fit the setting's own type`);
    }
  }
  if (panels.length === 0 && pages.length === 0) {
    warn('contributes', 'adds no panels or pages, so it never runs');
  }
}

/** Check a parsed `potentialpaper-plugin.json`, reporting every problem found. */
export function validateManifest(raw: unknown): ManifestReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const error = (path: string, message: string) => errors.push(path ? `${path}: ${message}` : message);
  const warn = (path: string, message: string) => warnings.push(path ? `${path}: ${message}` : message);
  if (!isObject(raw)) {
    error('', `${MANIFEST_FILE} must be a JSON object`);
    return { manifest: null, errors, warnings };
  }
  unknownFields(raw, warn);
  if (typeof raw.apiVersion === 'number' && raw.apiVersion > API_VERSION) {
    error('apiVersion', `the plugin is for API version ${raw.apiVersion}, and this site runs ${API_VERSION}`);
    return { manifest: null, errors, warnings };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const message =
        issue.code === 'invalid_type' && issue.input === undefined ? `required (${issue.message})` : issue.message;
      error(pathText(issue.path), message);
    }
    return { manifest: null, errors, warnings };
  }
  const { $schema: _schema, ...data } = parsed.data;
  void _schema;
  const manifest = data as unknown as PluginManifest;
  crossChecks(manifest, error, warn);
  return errors.length ? { manifest: null, errors, warnings } : { manifest, errors, warnings };
}

/** The manifest's JSON Schema, for `/schemas/plugin-manifest.json`. */
export function manifestJsonSchema(origin: string): Record<string, unknown> {
  const schema = z.toJSONSchema(manifestSchema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { ...schema, $id: `${origin}/schemas/plugin-manifest.json` };
}

/** A panel's id as settings and slots name it: `<plugin id>.<panel id>`. */
export function pluginPanelId(pluginId: string, panelId: string): string {
  return `${pluginId}.${panelId}`;
}

/** A plugin panel's id in `<kind>.panels.*`: a plugin id, a dot and the panel's id. */
export const PLUGIN_PANEL_ID_RE = new RegExp(
  `^${PLUGIN_ID_RE.source.slice(1, -1)}\\.${CONTRIBUTION_ID.source.slice(1, -1)}$`,
);
