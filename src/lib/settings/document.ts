import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { CORE_SETTINGS, isCoreSetting, readCoreValue } from './core';
import { sanitizeSettingValue, settingValueProblem, splitQualified, type PluginSettings } from './spec';

/**
 * A settings.json document: JSONC text, kept as written so its comments and key order survive, and parsed when
 * read. Keys are dotted (`paper.panels.hidden`); a plugin's are `<plugin id>.<name>`. The document holds only
 * what differs from the layer below it (defaults, then the site's, then the user's).
 *
 * Values are checked when read and never trusted when written: a value that doesn't fit reads as the layer below,
 * so a bad file never breaks a page. Writing (`checkSettings`) reports every problem at once.
 */

export type SettingsDoc = Record<string, unknown>;

/** The most a settings.json may hold. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

/** What a new document reads as. */
export const EMPTY_SETTINGS = '{}\n';

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false, allowEmptyContent: true };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The document's top-level object; `{}` for text that isn't one. Never throws. */
export function parseSettings(text: string | null | undefined): SettingsDoc {
  if (!text) return {};
  const tree = parseTree(text, [], PARSE_OPTIONS);
  if (!tree || tree.type !== 'object') return {};
  const out: SettingsDoc = {};
  for (const prop of tree.children ?? []) {
    const [keyNode, valueNode] = prop.children ?? [];
    if (keyNode && valueNode) out[keyNode.value as string] = nodeValue(valueNode);
  }
  return out;
}

function nodeValue(node: Node): unknown {
  switch (node.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const prop of node.children ?? []) {
        const [k, v] = prop.children ?? [];
        if (k && v) out[k.value as string] = nodeValue(v);
      }
      return out;
    }
    case 'array':
      return (node.children ?? []).map(nodeValue);
    default:
      return node.value;
  }
}

export interface SettingsProblem {
  severity: 'error' | 'warning';
  /** The key it is about; `null` for the file as a whole (a syntax error). */
  key: string | null;
  /** 1-based. */
  line: number;
  message: string;
}

/** A problem on one line, naming its key: `paper.panels.hidden: must not name a panel twice`. */
export function formatProblem(p: SettingsProblem): string {
  return p.key === null ? `line ${p.line}: ${p.message}` : `${p.key}: ${p.message}`;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Check a document, as a PUT does, against the core settings and the given plugins' settings. Errors make it
 * unsaveable; warnings don't. Unknown keys are kept, with a warning, so a file can name a plugin's settings before
 * the plugin is installed.
 */
export function checkSettings(
  text: string,
  plugins: PluginSettings[] = [],
  layer: 'user' | 'site' = 'user',
): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const error = (key: string | null, offset: number, message: string) =>
    problems.push({ severity: 'error', key, line: lineAt(text, offset), message });
  const warn = (key: string, offset: number, message: string) =>
    problems.push({ severity: 'warning', key, line: lineAt(text, offset), message });

  if (new TextEncoder().encode(text).length > MAX_SETTINGS_BYTES) {
    error(null, 0, `the file is larger than ${MAX_SETTINGS_BYTES / 1024} KB`);
    return problems;
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, PARSE_OPTIONS);
  for (const e of errors) error(null, e.offset, `${describeParseError(e)}`);
  if (errors.length > 0) return problems;
  if (!tree) return problems; // Empty: the same as `{}`.
  if (tree.type !== 'object') {
    error(null, tree.offset, 'a settings file is a JSON object of settings, { "key": value, … }');
    return problems;
  }

  const byId = new Map(plugins.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const prop of tree.children ?? []) {
    const [keyNode, valueNode] = prop.children ?? [];
    if (!keyNode || !valueNode) continue;
    const key = keyNode.value as string;
    const at = keyNode.offset;
    if (seen.has(key)) warn(key, at, 'set more than once; the last one counts');
    seen.add(key);
    const value = nodeValue(valueNode);

    if (isCoreSetting(key)) {
      const parsed = CORE_SETTINGS[key].schema.safeParse(value);
      if (!parsed.success) error(key, at, zodMessage(parsed.error.issues));
      else if (CORE_SETTINGS[key].siteOnly && layer === 'user') {
        warn(key, at, "set by the site's admins for everyone; it changes nothing in your file");
      } else if (CORE_SETTINGS[key].accountOnly && layer === 'site') {
        warn(key, at, "each account's own choice; the site's file changes nothing");
      }
      continue;
    }
    const qualified = splitQualified(key);
    if (!qualified) {
      warn(key, at, 'not a setting this site knows; kept');
      continue;
    }
    const plugin = byId.get(qualified.pluginId);
    if (!plugin) {
      warn(key, at, `for the plugin ${qualified.pluginId}, which isn't installed; kept`);
      continue;
    }
    const spec = Object.hasOwn(plugin.settings, qualified.name) ? plugin.settings[qualified.name] : undefined;
    if (!spec) {
      warn(key, at, `${qualified.pluginId} has no setting "${qualified.name}"; kept`);
      continue;
    }
    const problem = settingValueProblem(spec, value);
    if (problem) error(key, at, problem);
  }
  return problems;
}

function describeParseError(e: ParseError): string {
  const code = printParseErrorCode(e.error);
  // InvalidSymbol → "invalid symbol".
  return code.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function zodMessage(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => {
      const where = i.path.length ? `item ${i.path.map(String).join('.')}: ` : '';
      return `${where}${i.message}`;
    })
    .join('; ');
}

export interface SettingsLayers {
  /** The site layer, from `site_settings`. */
  site?: SettingsDoc;
  /** The user's document, or a signed-out reader's from localStorage. */
  user?: SettingsDoc;
}

export type ResolvedSettings = Record<string, unknown>;

/**
 * Every known setting's value: the user's where it reads, else the site's, else the default. Core keys first, then
 * each given plugin's, as `<plugin id>.<name>`. Unknown keys aren't in the result.
 */
export function resolveSettings(layers: SettingsLayers, plugins: PluginSettings[] = []): ResolvedSettings {
  const out: ResolvedSettings = {};
  const pick = (key: string, read: (raw: unknown) => unknown, fallback: unknown) => {
    for (const doc of [layers.user, layers.site]) {
      if (!doc || !Object.hasOwn(doc, key)) continue;
      const value = read(doc[key]);
      if (value !== undefined) return value;
    }
    return fallback;
  };
  for (const [key, setting] of Object.entries(CORE_SETTINGS)) {
    const read = (raw: unknown) => readCoreValue(setting, raw);
    if (setting.siteOnly) {
      const site = layers.site && Object.hasOwn(layers.site, key) ? read(layers.site[key]) : undefined;
      out[key] = site ?? setting.default;
    } else if (setting.accountOnly) {
      const user = layers.user && Object.hasOwn(layers.user, key) ? read(layers.user[key]) : undefined;
      out[key] = user ?? setting.default;
    } else {
      out[key] = pick(key, read, setting.default);
    }
  }
  for (const plugin of plugins) {
    for (const [name, spec] of Object.entries(plugin.settings)) {
      const key = `${plugin.id}.${name}`;
      out[key] = pick(key, (raw) => sanitizeSettingValue(spec, raw), spec.default);
    }
  }
  return out;
}

/** Whether two values are the same setting value. */
export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The text with one key set, or removed (`undefined`), keeping the rest of it, comments and order, as written. The
 * text must already parse as an object (`checkSettings` has no syntax errors); an empty text becomes one.
 */
export function setInSettings(text: string, key: string | string[], value: unknown): string {
  const base = text.trim() === '' ? EMPTY_SETTINGS : text;
  if (Array.isArray(key)) {
    // A key inside a setting's object (`plugins` → one source): jsonc-parser's edit, which keeps the rest.
    if (key.length === 1) return setInSettings(base, key[0], value);
    return applyEdits(
      base,
      modify(base, key, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }),
    );
  }
  if (value === undefined) {
    // Every time it is set, or an earlier one would count again.
    let out = base;
    for (let next = removeFromSettings(out, key); next !== out; next = removeFromSettings(out, key)) out = next;
    return out;
  }
  const edits = modify(base, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  return applyEdits(base, edits);
}

/**
 * The text without a key: its property, its comma and a comment on the same line go, and so does its line if
 * nothing else is on it. Comments on lines of their own stay, which jsonc-parser's own removal doesn't keep.
 */
function removeFromSettings(text: string, key: string): string {
  const tree = parseTree(text, [], PARSE_OPTIONS);
  const props = tree?.type === 'object' ? (tree.children ?? []) : [];
  // The last one, which is the one that counts.
  const i = props.findLastIndex((p) => p.children?.[0]?.value === key);
  if (i === -1) return text;
  const prop = props[i];
  const end = prop.offset + prop.length;
  const commaAfter = i < props.length - 1 ? commaBetween(text, end, props[i + 1].offset) : null;
  // The last property takes the comma before it with it, so the one before doesn't end in a comma.
  const commaBefore =
    commaAfter === null && i > 0 ? commaBetween(text, props[i - 1].offset + props[i - 1].length, prop.offset) : null;

  let start = prop.offset;
  let stop = commaAfter === null ? end : commaAfter + 1;
  stop += /^[ \t]*(\/\/[^\n]*)?/.exec(text.slice(stop))![0].length;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start)) && (text[stop] === '\n' || stop === text.length)) {
    start = lineStart;
    stop = Math.min(stop + 1, text.length);
  }
  let out = text.slice(0, start) + text.slice(stop);
  if (commaBefore !== null) out = out.slice(0, commaBefore) + out.slice(commaBefore + 1);
  return out;
}

// jsonc-parser's `SyntaxKind` is a const enum, which isolated modules can't read.
const COMMA = 5;
const EOF = 17;

/** Where the comma between two offsets is, outside comments. */
function commaBetween(text: string, from: number, to: number): number | null {
  const scanner = createScanner(text, false);
  scanner.setPosition(from);
  while (scanner.getPosition() < to) {
    const token = scanner.scan();
    if (token === EOF) break;
    if (token === COMMA) return scanner.getTokenOffset();
  }
  return null;
}

/** Whether the text is an object the form can edit: no syntax errors, and an object at the top. */
export function isEditable(text: string): boolean {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, PARSE_OPTIONS);
  return errors.length === 0 && (!tree || tree.type === 'object');
}

/** Where a key's value starts, for pointing the raw editor at it. */
export function keyOffset(text: string, key: string): number | null {
  const tree = parseTree(text, [], PARSE_OPTIONS);
  const node = tree && findNodeAtLocation(tree, [key]);
  return node ? node.offset : null;
}

export { isRecord as isSettingsObject };
