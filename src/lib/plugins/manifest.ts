import { z } from 'zod';
import { KINDS, PAGE_KINDS, type PageKind } from '../kinds';
import { PLUGIN_ID_RE, sanitizeSettingValue, SETTING_NAME_RE, type PluginSettingSpec } from '../settings/spec';
import { HANDLE_PATTERN } from '../profile';
import { MANIFEST_FILE } from './sources';
import { MAX_WHEN_LENGTH, whenKeys, parseWhen, whenProblem } from './when';

/**
 * A plugin's manifest, `potentialpaper-plugin.json` at the top of its folder (`handoffs/plugins.md` Phase 2, DESIGN.md
 * §10): what the plugin is, what it may do and what it adds. A plugin never touches the site's own interface. It
 * declares panels, pages, settings, commands and notes on rows, and the host draws them; its code runs in frames on an
 * origin of its own and reaches the site only through the RPC (`protocol.ts`).
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
  'scope.read': 'List the papers of venues, categories and organisations',
  'reviews.read': "Read papers' submissions, reviews and decisions",
  'lists.read':
    'See which papers the home page lists for you (your searches, your papers and those you follow), to add a note to each',
  identity:
    "Tell its own backend who you are: your handle, in a short-lived token signed by this site that only this plugin's backend accepts",
} as const;
export type PluginPermission = keyof typeof PERMISSIONS;
export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as PluginPermission[];

/**
 * Where on a page of a kind a panel goes (its place): its kind's `<kind>.main`, `<kind>.aside`, `<kind>.body` (below
 * both columns) or `<kind>.tabs`; on a paper also `submission` (`paper.submission`: once under each of its submissions
 * that has scores, in the Submissions section, the frame told which as `pp.context.surface.submission`), `community`
 * (after the community's sections) and `author` (after the authors' sections, only where the paper's authors list the
 * panel in `owners/plugins.json`, `lib/plugins/author-plugins.ts`).
 *
 * A panel's `slot` is the place it prefers. A reader may move a `movable` one to any other place its kind has
 * (`<kind>.panels.placement`), but `author`: only the authors put a panel there, and one made for it stays there.
 */
export const PANEL_SLOTS = ['main', 'aside', 'tab', 'body', 'submission', 'community', 'author'] as const;
export type PanelSlot = (typeof PANEL_SLOTS)[number];

/** Places only the page's owners can put a panel in. */
export const OWNERS_PLACES: readonly PanelSlot[] = ['author'];

/** What the settings form calls each place. */
export const PLACE_TITLES: Record<PanelSlot, string> = {
  main: 'Main column',
  aside: 'Side column',
  tab: 'Tabs',
  body: 'Below both',
  submission: 'Under each submission',
  community: "In the community's sections",
  author: "In the authors' sections",
};

/** The places of a kind's pages a reader may move a panel to. */
export function movablePlaces(kind: PageKind): PanelSlot[] {
  return PANEL_SLOTS.filter((p) => !OWNERS_PLACES.includes(p) && KINDS[kind].slots.includes(kindSlot(kind, p)));
}

/** The place a slot is, from its full name: `paper.tabs` is `tab`. */
export function placeOfSlot(slot: string): PanelSlot | null {
  const name = slot.slice(slot.indexOf('.') + 1);
  const place = name === 'tabs' ? 'tab' : name;
  return (PANEL_SLOTS as readonly string[]).includes(place) ? (place as PanelSlot) : null;
}

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

const settingValues = z
  .array(z.string().min(1).max(100))
  .min(1)
  .max(50)
  .meta({ description: 'The values it may take, in the order the form shows them.' });
const settingLabels = z
  .array(z.string().max(100))
  .optional()
  .meta({ description: 'What the form calls each value, one per value.' });
const settingCommon = {
  title: text(60, 'Its label in the form. Without one, the name spaced out: "showLegend" is "Show legend".').optional(),
  description: text(300, 'What it does, for the settings form.').optional(),
  group: text(60, 'A heading the form puts it under, on your settings page.').optional(),
  order: z.number().optional().meta({ description: 'Its place in the form: lower first, then as listed here.' }),
};

const settingSpecSchema = z
  .discriminatedUnion('type', [
    z.looseObject({ type: z.literal('boolean'), default: z.boolean(), ...settingCommon }),
    z.looseObject({
      type: z.literal('number'),
      default: z.number().nullable(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      ...settingCommon,
    }),
    z.looseObject({
      type: z.literal('string'),
      default: z.string(),
      maxLength: z.number().int().min(1).max(1000).optional(),
      multiline: z.boolean().optional().meta({ description: 'A box of several lines, not one line.' }),
      placeholder: z.string().max(100).optional(),
      ...settingCommon,
    }),
    z.looseObject({
      type: z.literal('enum'),
      default: z.string(),
      values: settingValues,
      labels: settingLabels,
      display: z
        .enum(['dropdown', 'radio'])
        .optional()
        .meta({ description: 'A dropdown (the default), or a radio button per value.' }),
      ...settingCommon,
    }),
    z.looseObject({
      type: z.literal('list'),
      default: z.array(z.string()),
      values: settingValues.optional(),
      labels: settingLabels,
      maxItems: z.number().int().min(1).max(100).optional(),
      maxLength: z.number().int().min(1).max(200).optional(),
      placeholder: z.string().max(100).optional(),
      ...settingCommon,
    }),
    z.looseObject({
      type: z.literal('set'),
      default: z.array(z.string()),
      values: settingValues,
      labels: settingLabels,
      ...settingCommon,
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
      'Where it prefers to go on each kind of page: "main", "aside", "tab" or "body" (below both columns), and on a paper "submission" (under each of its submissions with scores), "community" (after the community’s sections) or "author" (after the authors’ sections, only on papers whose authors list it in owners/plugins.json). One for every kind, or by kind with "*" for the rest: { "paper": "submission", "*": "main" }. Readers may move a movable panel to another place, but not into the authors’ sections.',
  });

const panelSchema = z.looseObject({
  id: contributionId('panel'),
  title: text(60, 'Its heading, and its name in settings.'),
  kinds: kindsSchema,
  slot: slotSchema,
  movable: z.boolean().default(true).meta({
    description:
      'Whether readers may move it to another place on the page in their settings (default true). A panel in the author section never moves.',
  }),
  when: z.string().max(MAX_WHEN_LENGTH).optional().meta({
    description:
      'Whether it shows on a page at all, as a condition on the page: "page.hasScores", "page.kind == venue && signedIn".',
  }),
});

const pageSchema = z.looseObject({
  id: contributionId('page'),
  title: text(60, "The page's title."),
  layout: z.enum(['article', 'full']).default('article').meta({
    description:
      '"article" (the default): under a heading, in the site\'s column, as tall as the frame asks. "full": the whole window under the site\'s bar, with no heading, for a map or a canvas; the frame is the window\'s size and ui.setHeight is ignored.',
  }),
  nav: z
    .union([z.boolean(), text(30, "The link's text.")])
    .optional()
    .meta({
      description:
        'Offer a link to it in the site\'s navbar: true, named by its title, or the link\'s own text ("map"). Readers arrange and hide it in settings (navbar.order, navbar.hidden).',
    }),
});

const actionSchema = z.looseObject({
  id: contributionId('action'),
  title: text(30, 'Its text in the bar under the title, and its name in settings: "translate".'),
  kinds: kindsSchema,
  when: z.string().max(MAX_WHEN_LENGTH).optional().meta({
    description: 'Whether it shows on a page at all, as a panel\'s "when": "page.hasScores", "signedIn".',
  }),
});

const commandSchema = z.looseObject({
  id: contributionId('command'),
  title: text(60, 'What it does, as its menu entry says it: "Copy as CSV".'),
});

/** A signal's name in its set: dotted lower-case words, so a group reads as one (`map.xy`, `map.region`). */
export const SIGNAL_NAME_RE = /^[a-z][a-z0-9-]{0,39}(?:\.[a-z][a-z0-9-]{0,39}){0,3}$/;
/** The most dimensions a vector signal may have. */
export const MAX_SIGNAL_DIMS = 2048;

const signalCommon = {
  id: z
    .string()
    .regex(SIGNAL_NAME_RE, 'a signal\'s id is dotted lower-case words, like "map.xy" or "rigour"')
    .meta({ description: "The signal's id in the set, `<set id>:<id>` everywhere else. Stable." }),
  title: text(60, 'Its name, as readers see it.'),
  description: text(300, 'What it captures, in a sentence, shown wherever it is used.').optional(),
};

const signalSchema = z
  .discriminatedUnion('kind', [
    z.looseObject({
      kind: z.literal('vector'),
      dims: z.number().int().min(1).max(MAX_SIGNAL_DIMS).meta({ description: 'How many numbers each value has.' }),
      metric: z
        .enum(['cosine', 'dot', 'l2'])
        .default('cosine')
        .meta({ description: 'How two values are compared, for nearest papers.' }),
      ...signalCommon,
    }),
    z.looseObject({
      kind: z.literal('number'),
      min: z.number().optional(),
      max: z.number().optional(),
      higher: z
        .enum(['better', 'worse', 'neither'])
        .default('neither')
        .meta({ description: 'Which end is better, if either.' }),
      ...signalCommon,
    }),
    z.looseObject({
      kind: z.literal('label'),
      ...signalCommon,
    }),
  ])
  .meta({
    description:
      'A value it computes for each paper: a vector (an embedding, a position on a map), a number or a label. The publisher writes the values through the API.',
  });

export type SignalSpec =
  | { kind: 'vector'; id: string; title: string; description?: string; dims: number; metric: 'cosine' | 'dot' | 'l2' }
  | {
      kind: 'number';
      id: string;
      title: string;
      description?: string;
      min?: number;
      max?: number;
      higher: 'better' | 'worse' | 'neither';
    }
  | { kind: 'label'; id: string; title: string; description?: string };

const rowCommandSchema = z.looseObject({
  id: contributionId('row command'),
  title: text(60, 'What it does, as the row\'s ⋯ menu says it: "Edit note".'),
  popover: z.boolean().optional().meta({
    description:
      "Open a frame of the plugin beside the row, told the command and the paper (pp.context.surface), for a form. Without it, the command runs in the plugin's list frame (pp.commands.register), given { paper }.",
  }),
});

const rowsSchema = z
  .looseObject({
    title: text(60, 'What its notes are, for settings: "Score standing".').optional(),
    commands: z.array(rowCommandSchema).max(8).default([]).meta({ description: "Entries in each row's ⋯ menu." }),
  })
  .meta({
    description:
      'Notes on the rows of the home page\'s list: one hidden frame per page is told the papers listed (pp.rows.papers) and sets a short note for any of them (pp.rows.set), which the row shows where it shows the venue. Needs the "lists.read" permission.',
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
    bot: z.string().regex(HANDLE_PATTERN, "a bot's handle, without the @").optional().meta({
      description:
        'The handle of the bot account whose files on pages this plugin shows, so the approval prompt can say where its data comes from. Naming a bot grants nothing.',
    }),
    publisher: z.string().regex(HANDLE_PATTERN, "an account's handle, without the @").optional().meta({
      description:
        "The handle of the account that writes this plugin's signals (contributes.signals). Committing it here is how the repo's owner names that account.",
    }),
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
        actions: z.array(actionSchema).max(4).default([]).meta({
          description:
            "Actions under a page's title, beside cite and share, each opening a popover with a frame of its own. Readers arrange and hide them in settings (<kind>.actions.order, <kind>.actions.hidden).",
        }),
        commands: z
          .array(commandSchema)
          .max(16)
          .default([])
          .meta({ description: "Commands, listed in each of its panels' menus." }),
        signals: z.array(signalSchema).max(20).default([]).meta({
          description: 'Values it publishes about papers, for any plugin and search to use. Needs a publisher.',
        }),
        rows: rowsSchema.optional(),
      })
      .default({ panels: [], pages: [], actions: [], settings: {}, commands: [], signals: [] }),
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
  /** Whether a reader may move it (`<kind>.panels.placement`); true unless the manifest says false. */
  movable: boolean;
  when?: string;
}

export interface ActionContribution {
  id: string;
  title: string;
  kinds: PageKind[];
  when?: string;
}

/** An entry in each row's ⋯ menu: run in the list frame, or with `popover`, in a frame of its own beside the row. */
export interface RowCommand {
  id: string;
  title: string;
  popover?: boolean;
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
  /** The bot account whose files on pages it shows (`handoffs/plugins.md` Phase 5); informational. */
  bot?: string;
  /** The account that writes its signals (`handoffs/signals.md`). */
  publisher?: string;
  contributes: {
    panels: PanelContribution[];
    pages: { id: string; title: string; layout: 'article' | 'full'; nav?: boolean | string }[];
    actions: ActionContribution[];
    settings: Record<string, PluginSettingSpec>;
    commands: { id: string; title: string }[];
    signals: SignalSpec[];
    /** Notes on the rows of the home page's list, and entries in each row's ⋯ menu. */
    rows?: { title?: string; commands: RowCommand[] };
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
  check(contributes, ['panels', 'pages', 'actions', 'settings', 'commands', 'signals', 'rows'], 'contributes');
  if (!isObject(contributes)) return;
  const each = (list: unknown, known: string[], at: string) =>
    Array.isArray(list) && list.forEach((item, i) => check(item, known, `${at}[${i}]`));
  each(contributes.panels, Object.keys(panelSchema.shape), 'contributes.panels');
  each(contributes.pages, Object.keys(pageSchema.shape), 'contributes.pages');
  each(contributes.actions, Object.keys(actionSchema.shape), 'contributes.actions');
  each(contributes.commands, Object.keys(commandSchema.shape), 'contributes.commands');
  if (Array.isArray(contributes.signals)) {
    const common = ['kind', ...Object.keys(signalCommon)];
    const fields: Record<string, string[]> = {
      vector: [...common, 'dims', 'metric'],
      number: [...common, 'min', 'max', 'higher'],
      label: common,
    };
    contributes.signals.forEach((spec, i) => {
      if (isObject(spec) && typeof spec.kind === 'string' && fields[spec.kind]) {
        check(spec, fields[spec.kind], `contributes.signals[${i}]`);
      }
    });
  }
  if (isObject(contributes.rows)) {
    check(contributes.rows, Object.keys(rowsSchema.shape), 'contributes.rows');
    each(contributes.rows.commands, Object.keys(rowCommandSchema.shape), 'contributes.rows.commands');
  }
  if (isObject(contributes.settings)) {
    const common = ['type', 'default', ...Object.keys(settingCommon)];
    const fields: Record<string, string[]> = {
      boolean: common,
      number: [...common, 'minimum', 'maximum'],
      string: [...common, 'maxLength', 'multiline', 'placeholder'],
      enum: [...common, 'values', 'labels', 'display'],
      list: [...common, 'values', 'labels', 'maxItems', 'maxLength', 'placeholder'],
      set: [...common, 'values', 'labels'],
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

/**
 * Where a panel goes on a page of a kind, for a reader: the place its `slot` prefers, or the one the reader's
 * `<kind>.panels.placement` moves it to, when the panel is movable and that place is one a reader may choose. A panel
 * made for the author section stays there. `null` if it doesn't go on that kind.
 */
export function panelPlace(
  panel: Pick<PanelContribution, 'kinds' | 'slot' | 'movable'>,
  kind: PageKind,
  moved: string | undefined,
): PanelSlot | null {
  const preferred = panelSlot(panel, kind);
  if (!preferred || OWNERS_PLACES.includes(preferred) || panel.movable === false || !moved) return preferred;
  return movablePlaces(kind).find((p) => p === moved) ?? preferred;
}

/** Checks the schema can't: ids unique, slots for every kind, conditions that parse, defaults that fit. */
function crossChecks(
  manifest: PluginManifest,
  error: (path: string, message: string) => void,
  warn: (path: string, message: string) => void,
) {
  const { panels, pages, actions, settings, commands, signals, rows } = manifest.contributes;
  const unique = (list: { id: string }[], at: string, what: string) => {
    const seen = new Set<string>();
    list.forEach((item, i) => {
      if (seen.has(item.id)) error(`${at}[${i}].id`, `a second ${what} "${item.id}"`);
      seen.add(item.id);
    });
  };
  /** A `when` that parses, over keys its kinds offer. */
  function checkWhen({ when, kinds }: { when?: string; kinds: PageKind[] }, at: string) {
    if (when === undefined) return;
    const problem = whenProblem(when);
    if (problem) {
      error(`${at}.when`, problem);
      return;
    }
    const keys = whenKeys(parseWhen(when));
    for (const kind of kinds) {
      const missing = keys.filter((key) => !(KINDS[kind].contextKeys as readonly string[]).includes(key));
      if (missing.length) {
        warn(`${at}.when`, `${kind} pages don't offer ${missing.join(', ')}, which read as false there`);
      }
    }
  }
  unique(panels, 'contributes.panels', 'panel');
  unique(pages, 'contributes.pages', 'page');
  unique(actions, 'contributes.actions', 'action');
  unique(commands, 'contributes.commands', 'command');
  unique(signals, 'contributes.signals', 'signal');
  signals.forEach((signal, i) => {
    if (signal.kind === 'number' && signal.min !== undefined && signal.max !== undefined && signal.min > signal.max) {
      error(`contributes.signals[${i}]`, 'its min is above its max');
    }
  });
  if (signals.length > 0 && !manifest.publisher) {
    error('publisher', 'signals need a publisher: the handle of the account that writes them');
  }
  if (rows) {
    unique(rows.commands, 'contributes.rows.commands', 'row command');
    if (!manifest.permissions.includes('lists.read')) {
      error('contributes.rows', 'needs the "lists.read" permission, to be told which papers are listed');
    }
  }

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
    checkWhen(panel, at);
  });
  actions.forEach((action, i) => {
    const at = `contributes.actions[${i}]`;
    if (new Set(action.kinds).size !== action.kinds.length) warn(`${at}.kinds`, 'names a kind twice');
    checkWhen(action, at);
  });

  for (const [name, spec] of Object.entries(settings)) {
    const at = `contributes.settings.${name}`;
    if ('values' in spec && spec.values) {
      if (spec.labels && spec.labels.length !== spec.values.length) {
        error(`${at}.labels`, `needs ${spec.values.length} labels, one per value`);
      }
      if (new Set(spec.values).size !== spec.values.length) error(`${at}.values`, 'names a value twice');
    } else if ('labels' in spec && spec.labels) {
      warn(`${at}.labels`, 'labels name "values", and there are none; ignored');
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
  if (manifest.permissions.includes('identity') && manifest.network.length === 0) {
    warn('permissions', '"identity" gives a token for your own backend, and "network" names none to send it to');
  }
  if (panels.length === 0 && pages.length === 0 && actions.length === 0 && signals.length === 0 && !rows) {
    warn('contributes', 'adds no panels, pages, actions, signals or rows, so it never runs');
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
