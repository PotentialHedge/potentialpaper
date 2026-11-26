import { eq } from 'drizzle-orm';
import { papers } from '@/db/schema';
import { ALL_PARTS, KINDS, type PageKind } from '@/lib/kinds';
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

/** A paper's files, as its `README.md` lists them: path, what it is, who may change it. */
type Row = [path: string, what: string, who: string];

const SYSTEM_ROW: Row = [
  '`README.md`, `prek.toml`, `.gitattributes`, `.potentialpaper/`',
  'this file, the checks, Git LFS, metadata',
  'only the site',
];

const PAPER_FILES: Row[] = [
  ['`paper.json`', 'the title, authors and abstract', 'its confirmed authors once claimed, else anyone verified'],
  ['`owners/NN-slug.md`', "the authors' sections, one file per section", "the paper's confirmed authors"],
  ['`owners/plugins.json`', "the plugins' panels the authors show", "the paper's confirmed authors"],
  ['`community/NN-slug.md`', 'the community sections, one file per section', 'anyone verified'],
  ['`<part>/links.jsonl`', "that part's labeled links", 'as its sections'],
  ['`<part>/facts.jsonl`', "that part's rows of the infobox", 'as its sections'],
  ['`versions/<id>.json`', 'a version of the paper: preprint, submission, camera-ready', 'anyone verified'],
  ['`versions/<id>.pdf`', "that version's PDF (Git LFS)", 'anyone verified'],
  ['`links/NN-slug.json`', 'a link under the title: `{ "label", "url" }`', 'as `paper.json`'],
  [
    '`thumbnail.png`',
    'the picture shown in place of the PDF (Git LFS; or `.jpg`, `.gif`, `.webp`, `.avif`)',
    'as `paper.json`',
  ],
  ['`thumbnail.json`', "the picture's alt text and caption", 'as `paper.json`'],
  [
    '`demos/<name>/…`',
    'a demo kept in the page, `index.html` and the files it loads',
    'anyone verified; its authors once their section shows it',
  ],
  ['`reviews/<source>/…`', "a submission's reviews and decisions, imported", 'only the import bot'],
  ['`extensions/<id>/…`', 'reserved for extensions', 'nobody yet'],
  SYSTEM_ROW,
];

/**
 * A page's `README.md`: how its repository is laid out and how to work in it. The same on every page of a kind, and
 * the system's, as `prek.toml` is (`check.ts` holds it to its one content), so it can't drift from what the site
 * takes. `scripts/add-page-starter.ts` writes it again into every repo when it changes.
 */
export function readme(kind: PageKind = 'paper', origin: string = siteUrl()): string {
  const host = new URL(origin).host;
  const table = (rows: Row[]) =>
    [
      '| Path | What it is | Who may change it |',
      '| --- | --- | --- |',
      ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
  const { kindFile, owners, community } = KINDS[kind];
  const rows: Row[] = [...PAPER_FILES];
  if (kind !== 'paper') {
    rows.length = 0;
    if (kindFile)
      rows.push([`\`${kindFile}\``, `what the ${kind} is`, owners ? `its ${owners.noun}` : 'anyone verified']);
    if (owners)
      rows.push(['`owners/NN-slug.md`', `${owners.title}' sections, one file per section`, `its ${owners.noun}`]);
    if (community)
      rows.push(['`community/NN-slug.md`', 'the community sections, one file per section', 'anyone verified']);
    rows.push(
      ['`<part>/links.jsonl`', "that part's labeled links", 'as its sections'],
      ['`extensions/<id>/…`', 'reserved for extensions', 'nobody yet'],
      SYSTEM_ROW,
    );
  }
  const what = kind === 'paper' ? "a paper's page" : `a ${kind}'s page`;
  return `# This is ${what} on ${host}

Each file here is part of the page: edit them, commit and \`git push\`, and the page shows your changes as if you had
made them on the site. The page's address is in \`.potentialpaper/metadata.json\`. This file is the same on every
page; the full guide is ${origin}/agent/setup.

## What's where

${table(rows)}

"Anyone verified" is any account with a confirmed institutional address.

## Sections

A part's sections show in the order of their file names, so \`10-summary.md\` comes before \`20-results.md\`. Name new
ones the same way: two digits, a dash and a lower-case slug. A section's title is the \`#\` heading it starts with, or
else its file name. Write in Markdown, or in HTML from a small allowlist of tags (no scripts, styles or classes).

${
  kind === 'paper'
    ? `The page starts with an empty file for each section it might have. An empty file isn't shown: write in one to add
that section, and rename or delete the rest as you like. `
    : ''
}Files are plain UTF-8 text, at most 256 KB each${kind === 'paper' ? ' (1 MB in `demos/`)' : ''}.
${
  kind === 'paper'
    ? `
## PDFs and the picture

They are kept with [Git LFS](https://git-lfs.com): install it and run \`git lfs install\` once, and a clone has them as
files; \`git push\` uploads them. A version's PDF sits beside its \`.json\`, at most 40 MB. The picture is one
\`thumbnail.*\`, at most 8 MB, named for its type.
`
    : ''
}
## Before you commit

\`prek.toml\` holds the checks the site runs: \`prek install\` once in this clone (https://prek.j178.dev), and each
commit is checked and formatted first. The site checks every push again.

## Pushing

To push, make an API key that may \`git push\` on your profile (${origin}/profile) and use it as the
password, or add an SSH key there. Commit as the id the site gives you on this page: push once, and if it is
wrong the push is refused with the two \`git config\` lines to run. Push one line of commits on \`main\`, on top
of the page as it is now (\`git pull --rebase\` first).
`;
}

/** Why this can't be the page's `README.md`, or `null`. */
export function readmeProblem(content: string, kind: PageKind = 'paper'): string | null {
  return content === readme(kind) ? null : 'is the same on every page, and fixed';
}

/**
 * The files a page's first commit starts with, besides its metadata and `.gitattributes`. Only a paper starts
 * with empty sections; what other kinds start with is decided with each kind's phase (`handoffs/pages.md`).
 */
export function starterFiles(kind: PageKind = 'paper'): [path: string, content: string][] {
  if (kind !== 'paper')
    return [
      [PREK_PATH, prekConfig()],
      [README_PATH, readme(kind)],
    ];
  return [
    [PREK_PATH, prekConfig()],
    [README_PATH, readme(kind)],
    ...(['owners', 'community'] as const).flatMap((part) =>
      STARTER_SECTIONS[part].map((name): [string, string] => [`${part}/${name}`, '']),
    ),
  ];
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
  files.push([GITATTRIBUTES_PATH, GITATTRIBUTES], ...starterFiles(page.kind));
  return files;
}

/**
 * What a page made before the starter files needs to have them: `prek.toml` and `README.md` as they are now (`fixed`
 * holds what the page has of each), and on a paper the empty sections of each part that has none yet, so nothing
 * anyone wrote is touched. None if it has them.
 */
export function missingStarterFiles(
  paths: ReadonlySet<string>,
  fixed: { prek?: string; readme?: string },
  kind: PageKind = 'paper',
): FileChange[] {
  const changes: FileChange[] = [];
  if (fixed.prek !== prekConfig()) changes.push({ path: PREK_PATH, content: prekConfig() });
  if (fixed.readme !== readme(kind)) changes.push({ path: README_PATH, content: readme(kind) });
  if (kind !== 'paper') return changes;
  for (const part of ['owners', 'community'] as const) {
    if ([...paths].some((path) => sectionName(path, part))) continue;
    for (const name of STARTER_SECTIONS[part]) changes.push({ path: `${part}/${name}`, content: '' });
  }
  return changes;
}
