import { PAPER_SCHEMES, PATH_PREFIX, type PaperScheme, parsePaperId } from '@/lib/paper-ids';
import type { GitAddress } from '../pages/clone';

/**
 * What an SSH client asks the server to run, parsed strictly: git sends `git-upload-pack '<path>'` for a
 * fetch and `git-receive-pack '<path>'` for a push, with the path quoted as git's `sq_quote` does (inside
 * single quotes, a `'` written `'\''` and a `!` written `'\!'`). Nothing else runs.
 */

export const GIT_SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;
export type GitService = (typeof GIT_SERVICES)[number];

const MAX_COMMAND = 1024;

/** The service and the path as git quoted it, or `null` for any other command. */
export function parseSshCommand(command: string): { service: GitService; path: string } | null {
  if (command.length > MAX_COMMAND) return null;
  const space = command.indexOf(' ');
  if (space === -1) return null;
  const service = GIT_SERVICES.find((s) => s === command.slice(0, space));
  if (!service) return null;
  const path = sqDequote(command.slice(space + 1));
  return path === null ? null : { service, path };
}

/** git's `sq_dequote`: one argument, in single quotes, with `'\''` and `'\!'` inside; `null` otherwise. */
export function sqDequote(arg: string): string | null {
  if (arg[0] !== "'") return null;
  let out = '';
  let i = 1;
  for (;;) {
    const close = arg.indexOf("'", i);
    if (close === -1) return null;
    out += arg.slice(i, close);
    i = close + 1;
    if (i === arg.length) return out;
    // Only `\'` or `\!` and a reopening quote may follow a closing one.
    if (arg[i] === '\\' && (arg[i + 1] === "'" || arg[i + 1] === '!') && arg[i + 2] === "'") {
      out += arg[i + 1];
      i += 3;
      continue;
    }
    return null;
  }
}

const PREFIXES = new Map<string, PaperScheme>([
  ...PAPER_SCHEMES.map((s) => [PATH_PREFIX[s].slice(1), s] as const),
  ...PAPER_SCHEMES.map((s) => [s, s] as const),
]);

/**
 * The page a path names, as a `GitAddress` for `findRepo`: the paper's own address (`/abs/1706.03762.git`, as
 * in `git@host:abs/1706.03762.git`), or the HTTP clone address's (`arxiv/1706.03762.git`, also under `/git/`),
 * with or without the leading slash and the `.git`. Not URL-encoded, unlike an HTTP address.
 */
export function parseSshPath(path: string, service: GitService): GitAddress | null {
  if (path.length > 512 || /[\x00-\x1f\x7f\\]/.test(path)) return null;
  let rest = path.startsWith('/') ? path.slice(1) : path;
  if (rest.startsWith('git/')) rest = rest.slice(4);
  if (rest.endsWith('.git')) rest = rest.slice(0, -4);
  const slash = rest.indexOf('/');
  if (slash === -1) return null;
  const scheme = PREFIXES.get(rest.slice(0, slash));
  const raw = rest.slice(slash + 1);
  if (!scheme || !raw || raw.endsWith('/') || raw.includes('//')) return null;
  const id = parsePaperId(scheme, raw);
  return id ? { id, scheme, raw, file: service } : null;
}
