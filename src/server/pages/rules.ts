/**
 * What may be written to a page repo, and by whom (DESIGN.md §4.3). Pure, and the only place these rules
 * are decided. Paths reach people's disks through `git clone`, so a path has to be safe on every
 * filesystem as well as valid to git.
 */

export const METADATA_PATH = 'metadata.json';
export const AUTHOR_PAGE_PATH = 'author/page.md';
export const COMMUNITY_PAGE_PATH = 'community/page.md';
export const RESOURCES_PATH = 'author/resources.json';

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_CHANGES = 50;
export const MAX_FILES = 1000;
export const MAX_SUMMARY_LENGTH = 300;
const MAX_PATH_BYTES = 1024;
const MAX_NAME_BYTES = 255;
const MAX_DEPTH = 8;
const MAX_JSON_DEPTH = 32;

/** Control and format characters take in git's "ignorable" code points, which can hide a `.git` on a Mac. */
const UNSAFE_CHARACTER = /[\p{C}\p{Zl}\p{Zp}\\:*?"<>|]/u;
/** `git~1` is `.git` on Windows, and `gitmod~1` is `.gitmodules`. Windows also reserves device names. */
const SHORT_NAME = /~\d/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Why a name cannot be in a tree, or `null`. Refusing every leading dot covers `.`, `..`, `.git` in all
 * its spellings, `.gitmodules` and `.gitattributes`: a page has no need of hidden files.
 */
function nameProblem(name: string): string | null {
  if (name === '') return 'has an empty name';
  if (name.startsWith('.')) return 'has a name starting with a dot';
  if (/^\s|[\s.]$/u.test(name)) return 'has a name starting with a space or ending with a space or dot';
  if (UNSAFE_CHARACTER.test(name)) return 'has a character that is not safe in a file name';
  if (SHORT_NAME.test(name) || WINDOWS_DEVICE.test(name)) return 'has a name that is reserved on Windows';
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return 'has a name that is too long';
  return null;
}

/** The path in normal form (NFC, so a Mac and Linux agree on it), or why it cannot be one. */
export function normalizePath(raw: string): { path: string } | { problem: string } {
  if (!raw.isWellFormed()) return { problem: 'is not valid Unicode' };
  const path = raw.normalize('NFC');
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) return { problem: 'is too long' };
  const names = path.split('/');
  if (names.length > MAX_DEPTH) return { problem: 'is nested too deeply' };
  for (const name of names) {
    const problem = nameProblem(name);
    if (problem) return { problem };
  }
  return { path };
}

export interface Roles {
  system: boolean;
  admin: boolean;
  /** Has a confirmed institutional address, or is a bot an operator minted. */
  verified: boolean;
  /** A confirmed author of this paper. Nobody is until claims exist (Milestone 5). */
  confirmedAuthor: boolean;
}

/** Why these roles cannot write this path, or `null`. Checked for each path of a commit. */
export function pathDenied(path: string, roles: Roles): string | null {
  if (path === METADATA_PATH) {
    return roles.system || roles.admin ? null : 'only the system and admins can change the metadata';
  }
  if (path.startsWith('author/')) {
    return roles.confirmedAuthor || roles.admin
      ? null
      : "only this paper's confirmed authors can edit its author section";
  }
  if (path.startsWith('community/')) {
    if (roles.system) return 'the system only writes the metadata';
    return roles.verified || roles.admin ? null : 'confirm an institutional email address first';
  }
  // Data owned by one extension (DESIGN.md §10). Nobody can act as one until extensions exist.
  if (path.startsWith('extensions/')) return 'this path is reserved for extensions';
  return 'pages only have metadata.json, author/, community/ and extensions/';
}

function jsonValueProblem(value: unknown, depth = 0): string | null {
  if (depth > MAX_JSON_DEPTH) return 'is nested too deeply';
  if (typeof value === 'string') {
    // Valid JSON that Postgres cannot store in a `jsonb` column, and so could not project.
    return value.includes('\0') || !value.isWellFormed() ? 'has a string Postgres cannot store' : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = jsonValueProblem(item, depth + 1);
      if (problem) return problem;
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const problem = jsonValueProblem(key, depth + 1) ?? jsonValueProblem(item, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

function jsonProblem(text: string, mustBeObject: boolean): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'is not valid JSON';
  }
  if (mustBeObject && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    return 'must be a JSON object';
  }
  return jsonValueProblem(value);
}

/**
 * Why this can't be the file's content, or `null`. Files are text, since media goes to R2 (DESIGN.md
 * §4.3). Checked after merging as well, because two valid edits can merge into invalid JSON. What a link
 * or a resource must contain is decided with those features (Milestones 4 and 5).
 */
export function contentProblem(path: string, content: string): string | null {
  if (!content.isWellFormed()) return 'is not valid Unicode';
  if (content.includes('\0')) return 'is not text';
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) return `is larger than ${MAX_FILE_BYTES} bytes`;
  if (path.endsWith('.jsonl')) {
    for (const line of content.split('\n')) {
      if (line === '') continue;
      const problem = jsonProblem(line, true);
      if (problem) return `has a line that ${problem}`;
    }
    return null;
  }
  if (path.endsWith('.json')) return jsonProblem(content, path === METADATA_PATH || path === RESOURCES_PATH);
  return null;
}

/** One line, whatever was typed. A commit's trailers depend on it (`encodeCommit`). */
export function cleanSummary(summary: string): string {
  const line = summary
    .toWellFormed()
    .normalize('NFC')
    .replace(/[\p{C}\p{Zl}\p{Zp}\s]+/gu, ' ')
    .trim();
  return [...line].slice(0, MAX_SUMMARY_LENGTH).join('').trim() || 'Edit';
}
