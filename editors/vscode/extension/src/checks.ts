import * as markdownPlugin from 'prettier/plugins/markdown';
import * as prettier from 'prettier/standalone';

/**
 * The hooks of the page's `prek.toml` (`src/server/pages/starter.ts`), as the web editor runs them before a commit,
 * since it has no terminal to run prek in. Pure, so the tests check them against what the hooks do. The JSON
 * Schemas (`check-jsonschema`) are VS Code's JSON support's, read from its diagnostics (`precommit.ts`).
 */

const SECTION = /^(author|community)\/[^/]+\.md$/;

/** `check-added-large-files --maxkb=256`. */
export const MAX_ADDED_KB = 256;

/** A file as the commit would write it. `added`: not in the page before. */
export interface CheckedFile {
  path: string;
  text: string;
  added: boolean;
}

export interface Problem {
  path: string;
  message: string;
}

const isDemo = (path: string) => path.startsWith('demos/');

/** A section as Prettier formats Markdown, with its defaults, as the `prettier` hook runs it. */
export function formatMarkdown(text: string): Promise<string> {
  return prettier.format(text, { parser: 'markdown', plugins: [markdownPlugin] });
}

/** JSON as `pretty-format-json --no-sort-keys` writes it, which is how the site writes it too; `null` if it isn't JSON. */
function formatJson(text: string): string | null {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return null;
  }
}

/** `trailing-whitespace --markdown-linebreak-ext=md`: a Markdown line's two closing spaces are a line break, and stay. */
export function trimTrailingWhitespace(path: string, text: string): string {
  const markdown = path.endsWith('.md');
  return text.replace(/^(.*?)([ \t\f\v]+)(\r?)$/gm, (_, line: string, space: string, cr: string) =>
    markdown && line.trim() !== '' && space.endsWith('  ') ? `${line}  ${cr}` : `${line}${cr}`,
  );
}

/** `end-of-file-fixer`: one newline at the end, none in a file of only newlines. */
export function fixEndOfFile(text: string): string {
  if (text === '') return text;
  const body = text.replace(/(\r?\n)+$/, '');
  if (body === '') return '';
  const eol = /\r\n$/.test(text) ? '\r\n' : '\n';
  return `${body}${eol}`;
}

/** The file as the hooks would leave it (`pretty-format-json`, `prettier`, the whitespace fixers), or `null` to leave it. */
export async function formatted(path: string, text: string): Promise<string | null> {
  if (isDemo(path)) return null;
  let out = text;
  if (SECTION.test(path) && text.trim() !== '') out = await formatMarkdown(out);
  if (path.endsWith('.json')) out = formatJson(out) ?? out;
  out = fixEndOfFile(trimTrailingWhitespace(path, out));
  return out === text ? null : out;
}

/** `check-illegal-windows-names`, as pre-commit-hooks spells it. */
const ILLEGAL_WINDOWS =
  /((^|\/)(CON|PRN|AUX|NUL|COM[\d¹²³]|LPT[\d¹²³])(\.|\/|$)|[<>:"\\|?*\x00-\x1F]|\/[^/]*[.\s]\/|[^/]*[.\s]$)/i;

/** Each path and the folders above it. */
function withFolders(paths: Iterable<string>): Set<string> {
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'));
  }
  return all;
}

/**
 * What the checking hooks refuse in these files: `check-json`, `check-added-large-files`, `check-case-conflict`
 * and `check-illegal-windows-names`. `all` is every path of the page as the commit would leave it, which an added
 * one mustn't clash with.
 */
export function problems(files: readonly CheckedFile[], all: Iterable<string>): Problem[] {
  const found: Problem[] = [];
  const byCase = new Map<string, string[]>();
  for (const path of withFolders(all))
    byCase.set(path.toLowerCase(), [...(byCase.get(path.toLowerCase()) ?? []), path]);
  for (const path of withFolders(files.filter((f) => f.added).map((f) => f.path))) {
    const clash = byCase.get(path.toLowerCase())?.find((other) => other !== path);
    if (clash !== undefined) found.push({ path, message: `differs from ${clash} only in upper and lower case` });
  }
  for (const { path, text, added: isNew } of files) {
    if (isNew && ILLEGAL_WINDOWS.test(path)) found.push({ path, message: 'is not a name a file can have on Windows' });
    if (path.endsWith('.json')) {
      try {
        JSON.parse(text);
      } catch (err) {
        found.push({ path, message: `is not JSON: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    const kb = Math.ceil(new TextEncoder().encode(text).length / 1024);
    if (isNew && !isDemo(path) && kb > MAX_ADDED_KB) {
      found.push({ path, message: `is ${kb} KB, over the ${MAX_ADDED_KB} KB a file added to a page may have` });
    }
  }
  return found;
}
