import { siteUrl } from '../site';
import type { FileChange } from './commit';
import { PREK_PATH, sectionName } from './rules';
import { PAGE_SCHEMAS } from './schemas';

/**
 * What every page repo starts with besides its metadata (`commit.ts` writes these into a page's first
 * commit, and `scripts/add-page-starter.ts` into pages made before): an empty file for each section a part
 * might have, which shows on the page once someone writes in it (`sections.ts` leaves blank files out), and
 * `prek.toml`, the checks a clone runs before each commit (https://prek.j178.dev).
 */

/** The sections each part starts with, empty. Renamed, reordered or deleted like any other. */
export const STARTER_SECTIONS: Record<'author' | 'community', readonly string[]> = {
  author: ['10-tl-dr.md', '20-overview.md', '30-results.md', '40-demos.md', '50-code-and-data.md', '60-talks.md'],
  community: [
    '10-summary.md',
    '20-why-it-matters.md',
    '30-critique.md',
    '40-errata.md',
    '50-reproductions.md',
    '60-follow-ups.md',
  ],
};

/** The pinned versions of the hooks `prek.toml` runs. The web editor formats Markdown with the same Prettier. */
const CHECK_JSONSCHEMA_REV = '0.39.0';
const PRETTIER_REV = 'v3.9.9';

/**
 * The page's `prek.toml`: the same on every page of a site, and only the system's to change, as it names
 * programs to run. The schemas are the site's (`schemas.ts`), the ones the web editor checks with.
 */
export function prekConfig(origin: string = siteUrl()): string {
  const schemaHooks = Object.entries(PAGE_SCHEMAS)
    .filter(([, entry]) => entry.writable)
    .map(
      ([name, entry]) =>
        `  { id = "check-jsonschema", name = "${entry.title.toLowerCase()} files", files = '${entry.filesRegex}', ` +
        `args = ["--schemafile", "${origin}/schemas/${name}.json"] },`,
    )
    .join('\n');
  return `# Checks run before each commit, with prek (https://prek.j178.dev): \`prek install\` once in this clone.
# The site checks every push again; these catch mistakes before you commit. The same on every page.

[[repos]]
repo = "builtin"
hooks = [
  { id = "check-json" },
  { id = "pretty-format-json", args = ["--autofix", "--no-sort-keys", "--no-ensure-ascii"], exclude = '^demos/' },
  { id = "end-of-file-fixer", exclude = '^demos/' },
  { id = "trailing-whitespace", args = ["--markdown-linebreak-ext=md"], exclude = '^demos/' },
  { id = "check-case-conflict" },
  { id = "check-illegal-windows-names" },
  { id = "check-added-large-files", args = ["--maxkb=256"], exclude = '^demos/' },
]

# Each JSON file against its schema (${origin}/schemas/).
[[repos]]
repo = "https://github.com/python-jsonschema/check-jsonschema"
rev = "${CHECK_JSONSCHEMA_REV}"
hooks = [
${schemaHooks}
]

# Sections formatted the way the web editor formats them.
[[repos]]
repo = "https://github.com/rbubley/mirrors-prettier"
rev = "${PRETTIER_REV}"
hooks = [
  { id = "prettier", files = '^(author|community)/.*\\.md$' },
]
`;
}

/** Why this can't be the page's `prek.toml`, or `null`. */
export function prekProblem(content: string): string | null {
  return content === prekConfig() ? null : 'is the same on every page, and fixed';
}

/** The files a page's first commit starts with, besides its metadata and `.gitattributes`. */
export function starterFiles(): [path: string, content: string][] {
  return [
    [PREK_PATH, prekConfig()],
    ...(['author', 'community'] as const).flatMap((part) =>
      STARTER_SECTIONS[part].map((name): [string, string] => [`${part}/${name}`, '']),
    ),
  ];
}

/**
 * What a page made before the starter files needs to have them: `prek.toml` (as it is now), and the empty
 * sections of each part that has none yet, so nothing anyone wrote is touched. None if it has them.
 */
export function missingStarterFiles(paths: ReadonlySet<string>, prek: string | undefined): FileChange[] {
  const changes: FileChange[] = [];
  if (prek !== prekConfig()) changes.push({ path: PREK_PATH, content: prekConfig() });
  for (const part of ['author', 'community'] as const) {
    if ([...paths].some((path) => sectionName(path, part))) continue;
    for (const name of STARTER_SECTIONS[part]) changes.push({ path: `${part}/${name}`, content: '' });
  }
  return changes;
}
