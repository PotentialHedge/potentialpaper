import { eq } from 'drizzle-orm';
import { pageCurrent, papers } from '@/db/schema';
import { ALL_PARTS, KINDS, type PageKind, pageName } from '@/lib/kinds';
import { encodePaperFile, paperFileOf } from '@/lib/paper-file';
import { siteUrl } from '../site';
import type { FileChange } from './commit';
import { mustPage } from './kinds';
import type { Reader } from './repo';
import {
  GITATTRIBUTES,
  GITATTRIBUTES_PATH,
  LAYOUT_VERSION,
  METADATA_PATH,
  PREK_PATH,
  README_PATH,
  sectionName,
} from './rules';
import { PAGE_SCHEMA_NAMES, PAGE_SCHEMAS } from './schemas';

/**
 * What every page repo starts with besides its metadata (`commit.ts` writes these into a page's first
 * commit, and `scripts/add-page-starter.ts` into pages made before): an empty file for each section a part
 * might have, which shows on the page once someone writes in it (`sections.ts` leaves blank files out), and
 * `prek.toml`, the checks a clone runs before each commit (https://prek.j178.dev).
 */

/** The sections each part starts with, empty. Renamed, reordered or deleted like any other. */
export const STARTER_SECTIONS: Record<'owners' | 'community', readonly string[]> = {
  owners: ['10-tl-dr.md', '20-overview.md', '30-results.md', '40-demos.md', '50-code-and-data.md', '60-talks.md'],
  community: [
    '10-tl-dr.md',
    '20-summary.md',
    '30-why-it-matters.md',
    '40-critique.md',
    '50-errata.md',
    '60-reproductions.md',
    '70-follow-ups.md',
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
  const schemaHooks = PAGE_SCHEMA_NAMES.map((name) => [name, PAGE_SCHEMAS[name]] as const)
    .filter(([, entry]) => entry.writable && (entry as { format?: string }).format !== 'jsonl')
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
  { id = "prettier", files = '^(${ALL_PARTS.join('|')})/.*\\.md$' },
]
`;
}

/** Why this can't be the page's `prek.toml`, or `null`. */
export function prekProblem(content: string): string | null {
  return content === prekConfig() ? null : 'is the same on every page, and fixed';
}

/** One line of the tree in a page's `README.md`: a file or folder at the top, and what it is. */
type Row = [name: string, what: string];

const PAPER_TREE: Row[] = [
  ['paper.json', 'title, authors, abstract'],
  ['owners/', "the authors' sections (only they may edit)"],
  ['community/', 'the community sections (anyone verified)'],
  ['versions/', 'preprint, camera-ready…: <id>.json and its PDF'],
  ['links/', 'the links under the title'],
  ['thumbnail.png', 'the picture shown for the paper'],
  ['demos/', 'demos the sections show'],
  ['reviews/', 'imported reviews (read-only)'],
];

/** The files only the site writes, last. */
const SYSTEM_TREE: Row[] = [
  ['README.md', "this file (the site's)"],
  ['prek.toml', "checks before each commit (the site's)"],
  ['.gitattributes', "Git LFS settings (the site's)"],
  ['.potentialpaper/', "page metadata (the site's)"],
];

/** Rows as a tree, `tree` would draw it: names padded so the notes line up. */
function drawTree(rows: Row[]): string {
  const width = Math.max(...rows.map(([name]) => name.length)) + 2;
  return [
    '.',
    ...rows.map(([name, what], i) => `${i === rows.length - 1 ? '└──' : '├──'} ${name.padEnd(width)}${what}`),
  ].join('\n');
}

/** A title on one line, as a heading takes it. */
function oneLine(title: string): string {
  return title.replace(/\s+/g, ' ').trim() || 'Untitled';
}

/** The `README.md` after its title: the same on every page of a kind. */
function readmeBody(kind: PageKind, origin: string): string {
  const { kindFile, owners, community } = KINDS[kind];
  const rows: Row[] =
    kind === 'paper'
      ? [...PAPER_TREE]
      : [
          ...(kindFile ? [[kindFile, `what the ${kind} is`] as Row] : []),
          ...(owners ? [['owners/', `${owners.title}' sections (only they may edit)`] as Row] : []),
          ...(community ? [['community/', 'the community sections (anyone verified)'] as Row] : []),
        ];
  rows.push(...SYSTEM_TREE);
  const paper = kind === 'paper';
  const host = new URL(origin).host;
  return `The files behind ${paper ? 'this paper' : `this ${kind}`}'s page on ${host}: commit, \`git push\`, and the page
shows your changes.

\`\`\`text
${drawTree(rows)}
\`\`\`

## Sections

One file each, \`NN-slug.md\`, shown in file-name order. The first \`#\` heading is the title. Markdown, or HTML from a
small allowlist. ${paper ? 'Empty files are not shown. ' : ''}At most 256 KB a file.
${
  paper
    ? `
## PDFs and pictures

Kept with [Git LFS](https://git-lfs.com): run \`git lfs install\` once. PDFs up to 40 MB, the picture up to 8 MB.
`
    : ''
}
## Pushing

Run \`prek install\` once to check each commit as the site will (https://prek.j178.dev). Push to \`main\`, on top of
the page as it is (\`git pull --rebase\` first). Use an API key from ${origin}/profile as the password, or add an
SSH key there.

## For AI agents

\`\`\`text
This repo is a page on ${host}. Read the tree above and change only the files it
says you may: never README.md, prek.toml, .gitattributes or .potentialpaper/.
Write sections in Markdown, one file each, named NN-slug.md.
Before committing, run \`prek run --all-files\` and fix what it reports.
Commit with a one-line summary, \`git pull --rebase\`, then \`git push\`.
If the push is refused, its message says what to fix.
\`\`\`
`;
}

/**
 * A page's `README.md`: its title, then how its repository is laid out and how to work in it, the same on every page
 * of a kind. The system's, as `prek.toml` is (`check.ts` holds it to that form), so it can't drift from what the site
 * takes. `scripts/add-page-starter.ts` writes it again into every repo when it changes, or the page's title does.
 */
export function readme(kind: PageKind, title: string, origin: string = siteUrl()): string {
  return `# ${oneLine(title)}\n\n${readmeBody(kind, origin)}`;
}

/** Why this can't be the page's `README.md`, or `null`: any one-line title, over the body every page of its kind has. */
export function readmeProblem(content: string, kind: PageKind = 'paper'): string | null {
  const title = /^# [^\n]+\n\n/.exec(content);
  return title && content.slice(title[0].length) === readmeBody(kind, siteUrl())
    ? null
    : 'is the same on every page but its title, and fixed';
}

/**
 * The files a page's first commit starts with, besides its metadata and `.gitattributes`, for a page called `title`.
 * Only a paper starts with empty sections; what other kinds start with is decided with each kind's phase
 * (`handoffs/pages.md`).
 */
export function starterFiles(kind: PageKind, title: string): [path: string, content: string][] {
  const fixed: [string, string][] = [
    [PREK_PATH, prekConfig()],
    [README_PATH, readme(kind, title)],
  ];
  if (kind !== 'paper') return fixed;
  return [
    ...fixed,
    ...(['owners', 'community'] as const).flatMap((part) =>
      STARTER_SECTIONS[part].map((name): [string, string] => [`${part}/${name}`, '']),
    ),
  ];
}

/** What a page is called, for its `README.md`: its name as last committed, else its paper's title or its key. */
export async function pageTitle(db: Reader, pageId: string): Promise<string> {
  const page = await mustPage(db, pageId);
  const [current] = await db.select({ name: pageCurrent.name }).from(pageCurrent).where(eq(pageCurrent.pageId, pageId));
  if (current?.name) return current.name;
  if (page.kind !== 'paper') return pageName(page.kind, page.key, null);
  const [paper] = await db.select({ title: papers.title }).from(papers).where(eq(papers.id, pageId));
  return paper?.title ?? page.key;
}

/** The page's starter files (`starterFiles`), under its title. */
export async function starterFilesOf(db: Reader, pageId: string): Promise<[path: string, content: string][]> {
  const page = await mustPage(db, pageId);
  return starterFiles(page.kind, await pageTitle(db, pageId));
}

/**
 * Every file a page's first commit writes by itself, in order (DESIGN.md §4.2): its `metadata.json` (`{ layout, kind,
 * key }`, in the layout the repo starts in), a paper's first `paper.json` from its row as the paper's source filled it
 * in (`server/papers.ts`; from then on the file is what the paper is, and the row its projection), `.gitattributes`
 * and the starter files. `commitPage` writes these, less what the edit itself says, and the Repo tab shows them for a
 * paper with no repo yet (`browse.ts`), so the two can't differ. Reads, never writes.
 */
export async function firstCommitFiles(db: Reader, pageId: string): Promise<[path: string, content: string][]> {
  const page = await mustPage(db, pageId);
  const files: [string, string][] = [
    [METADATA_PATH, `${JSON.stringify({ layout: LAYOUT_VERSION, kind: page.kind, key: page.key }, null, 2)}\n`],
  ];
  if (page.kind === 'paper') {
    const [paper] = await db.select().from(papers).where(eq(papers.id, pageId));
    files.push([KINDS.paper.kindFile!, encodePaperFile(paperFileOf(paper))]);
  }
  files.push([GITATTRIBUTES_PATH, GITATTRIBUTES], ...(await starterFilesOf(db, pageId)));
  return files;
}

/**
 * What a page made before the starter files needs to have them: `prek.toml` and `README.md` as they are now, under the
 * page's `title` (`fixed` holds what the page has of each), and on a paper the empty sections of each part that has none yet, so nothing
 * anyone wrote is touched. None if it has them.
 */
export function missingStarterFiles(
  paths: ReadonlySet<string>,
  fixed: { prek?: string; readme?: string },
  kind: PageKind,
  title: string,
): FileChange[] {
  const changes: FileChange[] = [];
  if (fixed.prek !== prekConfig()) changes.push({ path: PREK_PATH, content: prekConfig() });
  if (fixed.readme !== readme(kind, title)) changes.push({ path: README_PATH, content: readme(kind, title) });
  if (kind !== 'paper') return changes;
  for (const part of ['owners', 'community'] as const) {
    if ([...paths].some((path) => sectionName(path, part))) continue;
    for (const name of STARTER_SECTIONS[part]) changes.push({ path: `${part}/${name}`, content: '' });
  }
  return changes;
}
