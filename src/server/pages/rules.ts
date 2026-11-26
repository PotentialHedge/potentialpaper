import { z } from 'zod';
import { DEMO_NAME, DEMOS_DIR, MAX_DEMO_NAME } from '@/lib/demos';
import { KINDS, OWNERS_DIR, PAGE_KINDS, type PageKind, partsOf } from '@/lib/kinds';
import { LINKS_FILE, parseLabeledLinks } from '@/lib/labeled-links';
import { FACTS_FILE, parseFacts } from '@/lib/infobox-facts';
import { parseLinkFile } from '@/lib/paper-links';
import {
  parseReviewPath,
  parseReviewFile,
  parseVenueFormsFile,
  REVIEWS_DIR,
  reviewSourceOf,
  VENUE_FORMS_FILE,
} from '@/lib/review-files';
import { parseVersionFile, VERSION_ID, type VersionPdf } from '@/lib/versions';
import { AUTHOR_PLUGINS_PATH, parseAuthorPlugins } from '@/lib/plugins/author-plugins';
import { htmlProblem } from './html';

/**
 * What may be written to a page repo, and by whom (DESIGN.md §4.3). Pure, and the only place these rules
 * are decided. Paths reach people's disks through `git clone`, so a path has to be safe on every
 * filesystem as well as valid to git. The layout is many small files a person can edit with a text editor:
 *
 *   .gitattributes                  the system's, always the same: which files are kept with Git LFS
 *   prek.toml                       the system's, always the same: checks to run before a commit
 *   README.md                       the system's, the same on every page of a kind: how the repo is laid out
 *   .potentialpaper/metadata.json   the system's: the layout's version, the kind and the key
 *   paper.json                      the paper's title, authors and abstract (`lib/kinds.ts`)
 *   owners/10-overview.md           the owners' sections (on a paper, its confirmed authors'), a file per section
 *                                   (Markdown or HTML)
 *   owners/plugins.json             the plugins' panels the authors let into them (`lib/plugins/author-plugins.ts`)
 *   community/10-tl-dr.md           the community section, the same way
 *   versions/v_k3x9q2ab.json        a version of the paper, named by its id
 *   versions/v_k3x9q2ab.pdf         that version's PDF (Git LFS); every PDF of a paper is a version's
 *   links/10-code.json              a link under the title
 *   thumbnail.png                   the paper's picture (Git LFS), or .jpg, .gif, .webp, .avif
 *   thumbnail.json                  its alt text and caption
 *   demos/<name>/index.html         a demo, with its other files beside it
 *   reviews/<source>/<submission>/  a bot's import of a submission and its notes (`lib/review-files.ts`)
 *   extensions/<id>/…               reserved
 *
 * Every kind of page (`lib/kinds.ts`) has the same shape: `.gitattributes`, `prek.toml`, `README.md` and
 * `.potentialpaper/` for the system, its parts' sections (`<part>/NN-slug.md`) and each part's labeled links
 * (`<part>/links.jsonl`), its kind file, and `extensions/`. The rest above is a paper's own. Other kinds today:
 *
 *   venue.json, category.json, org.json or profile.json   the kind file (`lib/kinds.ts`)
 *   forms.json                      a venue's forms for its notes, by source (`lib/review-files.ts`)
 *   owners/                         the owners' sections, where the kind has owners; community/ on all but a user's
 *   <part>/links.jsonl              that part's labeled links
 *   <part>/facts.jsonl              that part's rows of the infobox (papers and venues)
 *
 * PDFs and pictures are Git LFS pointers (`parseLfsPointer`): the repo holds their hash and size, the bytes
 * are in R2 (`server/lfs.ts`), and `git lfs` moves them through the batch API (`server/git/lfs.ts`).
 */

/** Files only the system and admins write. The one directory whose name may start with a dot. */
export const SYSTEM_DIR = '.potentialpaper';
export const METADATA_PATH = `${SYSTEM_DIR}/metadata.json`;
const SYSTEM_PATHS = new Set([METADATA_PATH]);

/**
 * The version of this layout, which `metadata.json` records as `"layout"`, so that after a breaking change
 * we can tell which repos are laid out which way. Raise it with each change a repo has to be moved for,
 * and have that move's plan (`layout-migration.ts`) record it.
 *
 *   1  the first layout: one `page.md` per part, `links.json`, `versions.jsonl`, the system's files at the
 *      top. Its `metadata.json` has no `"layout"`.
 *   2  files and folders: a file per section, link and version, the system's files in `.potentialpaper/`
 *      (`planLayout`)
 *   3  PDFs and pictures as Git LFS pointers, with `.gitattributes` (`planLfs`)
 *   4  the owners' part is `owners/` on every kind, not `author/`, `organizers/`, `members/` or `about/` (`planOwners`)
 *   5  every PDF is a version's (no `.potentialpaper/paper.pdf` or `pdf.json`), and a version records where it was
 *      submitted and what each venue decided, which `submission.json` no longer says. No move: the database was
 *      wiped and reseeded.
 *   6  a paper's title, authors and abstract are in `paper.json`, and its `metadata.json` says only the layout, the
 *      kind and the key, as every other kind's does: no copy of the paper that could go stale (`planPaperFile`)
 *   7  a venue's name and forms are kept once, on its page: a venue page's `forms.json` holds its forms by source, a
 *      `submission.json` names only the venue's id (`submission/2`) and has no `forms.json` beside it, and an
 *      imported version entry names the venue's page (`"page"`) in place of its name (`planVenueData`)
 */
export const LAYOUT_VERSION = 7;

/** The layout a page's `metadata.json` says it has; `null` if it says none, as the first layout's doesn't. */
export function layoutVersionOf(metadata: string | undefined): number | null {
  try {
    const value = JSON.parse(metadata ?? '') as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const layout = (value as Record<string, unknown>).layout;
    return typeof layout === 'number' && Number.isSafeInteger(layout) && layout > 0 ? layout : null;
  } catch {
    return null;
  }
}

/** `metadata.json` saying it has layout `version`, first; or `null` if it isn't a JSON object to say it in. */
export function withLayoutVersion(metadata: string, version: number): string | null {
  let value: unknown;
  try {
    value = JSON.parse(metadata);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { layout: _old, ...rest } = value as Record<string, unknown>;
  void _old;
  return `${JSON.stringify({ layout: version, ...rest }, null, 2)}\n`;
}

/**
 * Every page has this, and only this, so that `git lfs` keeps PDFs and pictures as pointers on a clone and
 * on `git add`. Nobody can change it: an attribute can name a filter, and filters run programs.
 */
export const GITATTRIBUTES_PATH = '.gitattributes';
/**
 * The checks a clone runs before each commit (`starter.ts`): the same on every page, and the system's, as it
 * names programs to run. `check.ts` holds it to its one content.
 */
export const PREK_PATH = 'prek.toml';
/** How the page's repository is laid out (`starter.ts`): the same on every page of a kind, and the system's. */
export const README_PATH = 'README.md';
export const GITATTRIBUTES = `# PDFs and pictures are kept with Git LFS (https://git-lfs.com). With it installed (\`git lfs install\`),
# a clone has the files, and \`git add\` of one stores a pointer. This file is the same on every page.
/.potentialpaper/*.pdf filter=lfs diff=lfs merge=lfs -text
/versions/*.pdf filter=lfs diff=lfs merge=lfs -text
/thumbnail.png filter=lfs diff=lfs merge=lfs -text
/thumbnail.jpg filter=lfs diff=lfs merge=lfs -text
/thumbnail.jpeg filter=lfs diff=lfs merge=lfs -text
/thumbnail.gif filter=lfs diff=lfs merge=lfs -text
/thumbnail.webp filter=lfs diff=lfs merge=lfs -text
/thumbnail.avif filter=lfs diff=lfs merge=lfs -text
`;

/**
 * The words for the picture of the paper, which shows in place of its PDF's first page: its alt text and
 * caption. The picture is \`thumbnail.<ext>\` beside it. They and the links are the paper's card: its
 * confirmed authors' once it is claimed, and anyone verified's until then.
 */
export const THUMBNAIL_PATH = 'thumbnail.json';
/** Links to the paper elsewhere (code, project page, video), shown under its title (`lib/paper-links.ts`). */
export const LINKS_DIR = 'links';
/**
 * The paper's versions (`lib/versions.ts`): its preprint, submissions, camera-ready. Facts about the paper
 * that anyone verified can add to with evidence, as the community section; the system writes them on import.
 */
export const VERSIONS_DIR = 'versions';

/**
 * Demos kept in the page itself (`lib/demos.ts`): a folder each, `demos/<name>/`, with an `index.html` and
 * the files it loads, served from the demo host as a copied demo is. **Text only for now** (UTF-8, as every
 * file of a page is): pictures go in as SVG, and a demo with binary files (images, models, wasm) comes
 * from GitHub instead, whose copies go to the blob store. Binary blobs in Postgres would grow every page's
 * history, and nothing in the commit path handles bytes yet.
 */
/** The types a demo folder may hold, so the demo host serves each with a known type. */
const DEMO_EXTENSIONS = new Set(
  'html htm js mjs css json map webmanifest svg txt md csv tsv xml glsl wgsl vert frag obj gltf'.split(' '),
);
/** A bundled script is often past the 256 KB a page's other files may have. */
export const MAX_DEMO_FILE_BYTES = 1024 * 1024;
/** All of a page's demo folders together. Larger demos come from GitHub. */
export const MAX_DEMOS_BYTES = 5 * 1024 * 1024;
export const MAX_DEMOS_FILES = 300;

/** The folder a path is in, as `demos/<name>/…`, and its path inside it; or `null`. */
export function demoPath(path: string): { name: string; inside: string } | null {
  const match = /^demos\/([^/]+)\/(.+)$/.exec(path);
  return match && { name: match[1], inside: match[2] };
}

export function isDemoPath(path: string): boolean {
  return path.startsWith(`${DEMOS_DIR}/`);
}

/**
 * A part of a page written as prose, a directory of section files: `owners/` and `community/`. Each kind has its
 * own (`partsOf`); these are a paper's.
 */
export type PagePart = string;
export const PAGE_PARTS: readonly PagePart[] = partsOf('paper');

/**
 * A section's file name: two digits, a slug and the format, `20-why-it-matters.md`. Sections show in the
 * order of their names, as `ls` lists them, and the fixed two digits make that the numbers' order. The
 * slug is lower case, so no two names differ only in case, which a Mac or Windows clone couldn't hold.
 * A link's file is named the same way, as `.json`.
 */
const ORDERED_NAME = /^(\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\.(md|html|json)$/;
const MAX_SLUG = 60;
export const MAX_SECTIONS = 99;

export type SectionFormat = 'markdown' | 'html';

export interface OrderedName {
  order: number;
  slug: string;
  extension: 'md' | 'html' | 'json';
}

export function parseOrderedName(name: string): OrderedName | null {
  const match = ORDERED_NAME.exec(name);
  if (!match || match[2].length > MAX_SLUG) return null;
  return { order: Number(match[1]), slug: match[2], extension: match[3] as OrderedName['extension'] };
}

/** `20-why-it-matters`'s order and slug, if the path is a section file of the part. */
export function sectionName(path: string, part: PagePart): (OrderedName & { format: SectionFormat }) | null {
  if (!path.startsWith(`${part}/`)) return null;
  const name = parseOrderedName(path.slice(part.length + 1));
  if (!name || name.extension === 'json') return null;
  return { ...name, format: name.extension === 'md' ? 'markdown' : 'html' };
}

/** Whether the path is a part's infobox rows, `<part>/facts.jsonl`, on a page of a kind that has them. */
export function isFactsPath(path: string, kind: PageKind = 'paper'): boolean {
  const slash = path.indexOf('/');
  return (
    (KINDS[kind].fileTypes as readonly string[]).includes('fact') &&
    slash > 0 &&
    path.slice(slash + 1) === FACTS_FILE &&
    partsOf(kind).includes(path.slice(0, slash))
  );
}

/** Whether the path is a part's labeled links, `<part>/links.jsonl`, on a page of this kind. */
export function isLabeledLinksPath(path: string, kind: PageKind = 'paper'): boolean {
  const slash = path.indexOf('/');
  return slash > 0 && path.slice(slash + 1) === LINKS_FILE && partsOf(kind).includes(path.slice(0, slash));
}

/** The part a path is in, if it is in one of the kind's: `community` for `community/10-summary.md`. */
export function partOf(path: string, kind: PageKind = 'paper'): PagePart | null {
  const slash = path.indexOf('/');
  const part = slash > 0 ? path.slice(0, slash) : '';
  return partsOf(kind).includes(part) ? part : null;
}

export function isLinkPath(path: string): boolean {
  return path.startsWith(`${LINKS_DIR}/`) && parseOrderedName(path.slice(LINKS_DIR.length + 1))?.extension === 'json';
}

/** The version id a path names, as `versions/<id>.json`, or `null`. */
export function versionIdOf(path: string): string | null {
  const match = /^versions\/([^/]+)\.json$/.exec(path);
  return match && VERSION_ID.test(match[1]) ? match[1] : null;
}

export function versionPath(id: string): string {
  return `${VERSIONS_DIR}/${id}.json`;
}

/** The version whose PDF a path is, as `versions/<id>.pdf`, or `null`. */
export function versionPdfIdOf(path: string): string | null {
  const match = /^versions\/([^/]+)\.pdf$/.exec(path);
  return match && VERSION_ID.test(match[1]) ? match[1] : null;
}

export function versionPdfPath(id: string): string {
  return `${VERSIONS_DIR}/${id}.pdf`;
}

/** A picture's type by its file name's extension, as `thumbnail.<ext>` is named. */
const THUMBNAIL_EXTENSIONS: Record<string, ThumbnailType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/** The type the name of the picture says, as `thumbnail.png`, or `null` if the path isn't the picture. */
export function thumbnailImageType(path: string): ThumbnailType | null {
  const match = /^thumbnail\.([a-z]+)$/.exec(path);
  return (match && THUMBNAIL_EXTENSIONS[match[1]]) ?? null;
}

/** Where a picture of this type goes. */
export function thumbnailImagePath(type: ThumbnailType): string {
  const extension = Object.entries(THUMBNAIL_EXTENSIONS).find(([, t]) => t === type)![0];
  return `thumbnail.${extension}`;
}

/** What a Git LFS file at this path has to be, or `null` if the path isn't one. */
export function lfsKindOf(path: string): 'pdf' | 'image' | null {
  if (versionPdfIdOf(path)) return 'pdf';
  if (thumbnailImageType(path)) return 'image';
  return null;
}

export const PDF_TYPE = 'application/pdf';

/** An uploaded PDF is at most this (`server/files.ts` takes the same). */
export const MAX_LFS_PDF_BYTES = 40 * 1024 * 1024;
/**
 * A pointer may name a larger PDF than can be uploaded: the imports stored some (proceedings with appendices of
 * 50 MB). Only files stored here can be named anyway (`check.ts`).
 */
const MAX_POINTED_PDF_BYTES = 200 * 1024 * 1024;

export interface LfsPointer {
  sha256: string;
  bytes: number;
}

const LFS_VERSION = 'version https://git-lfs.github.com/spec/v1';

/**
 * A Git LFS pointer file (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md), or `null`. Only the
 * three lines `git lfs` writes, in its order, so a pointer has one spelling and so one blob.
 */
export function parseLfsPointer(text: string): LfsPointer | null {
  const match =
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9]\d{0,15})\n$/.exec(
      text,
    );
  if (!match) return null;
  const bytes = Number(match[2]);
  return Number.isSafeInteger(bytes) ? { sha256: match[1], bytes } : null;
}

export function encodeLfsPointer({ sha256, bytes }: LfsPointer): string {
  return `${LFS_VERSION}\noid sha256:${sha256}\nsize ${bytes}\n`;
}

/** What a page of a kind holds, said when a path isn't one of them. */
function kindLayout(kind: PageKind): string {
  const parts = partsOf(kind).map((part) => `${part}/`);
  const sections = `${parts.join(' and ')} (sections named like 10-summary.md or 20-results.html, links.jsonl${(KINDS[kind].fileTypes as readonly string[]).includes('fact') ? ', facts.jsonl' : ''}${kind === 'paper' ? `; ${OWNERS_DIR}/ also plugins.json` : ''})`;
  if (kind !== 'paper') {
    const forms = kind === 'venue' ? `, ${VENUE_FORMS_FILE}` : '';
    return `${kind} pages hold .gitattributes, prek.toml, README.md, ${METADATA_PATH}, ${KINDS[kind].kindFile}${forms}, ${sections} and extensions/`;
  }
  return (
    `pages hold .gitattributes, prek.toml, README.md, .potentialpaper/ (metadata.json), paper.json, ${sections}, ` +
    'versions/<id>.json and <id>.pdf, links/ (named like 10-code.json), thumbnail.png (or .jpg, .gif, .webp, .avif) ' +
    'and thumbnail.json, demos/<name>/, reviews/<source>/<submission>/ and extensions/'
  );
}

const REVIEWS_LAYOUT =
  'reviews/<source>/<submission>/ holds submission.json and notes/<id>.json, each name a lower-case ' +
  "slug (letters, digits, - and _); the venue's forms are on its page";

const CONFIRM = 'confirm an institutional email address first';
const METADATA_ONLY = 'the system only writes the metadata';

/**
 * One kind of path on a page, and who writes it: the whole of the rules of DESIGN.md §4.3, as `rulesOf` lists them for
 * each kind. The first rule that covers a path decides both whether it is laid out right and who may write it.
 */
interface PathRule {
  covers(path: string): boolean;
  /** Why the path, which this rule covers, is no file this page can hold; `null` if it is one. */
  layout(path: string): string | null;
  /** Why these roles can't write it, or `null`. */
  denied(roles: Roles, path: string): string | null;
}

const fine = () => null;

/** Who may write: each is why these roles can't, or `null`. */
const may = {
  system: (roles: Roles) =>
    roles.system || roles.admin ? null : `only the system and admins can change ${SYSTEM_DIR}/`,
  /** Anyone verified, but not the system, which writes only the metadata. */
  verified: (roles: Roles) => (roles.system ? METADATA_ONLY : roles.verified || roles.admin ? null : CONFIRM),
  owners: (refusal: string) => (roles: Roles) => (roles.owner || roles.admin ? null : refusal),
  granted: (roles: Roles, path: string) => roles.grants?.some((pattern) => grantCovers(pattern, path)) ?? false,
};

/** A part's files: its sections, its labeled links, and on a paper's owners' part the plugins they let in. */
function partRule(kind: PageKind, part: string, denied: PathRule['denied']): PathRule {
  return {
    covers: (path) => path.startsWith(`${part}/`),
    layout: (path) =>
      sectionName(path, part) ||
      isLabeledLinksPath(path, kind) ||
      isFactsPath(path, kind) ||
      (kind === 'paper' && path === AUTHOR_PLUGINS_PATH)
        ? null
        : `${part}/ holds one file per section, named like 10-summary.md or 20-results.html (two digits, a lower-case slug), ${LINKS_FILE}${(KINDS[kind].fileTypes as readonly string[]).includes('fact') ? ` and ${FACTS_FILE}` : ''}`,
    denied,
  };
}

/** Who writes a keyed kind's kind file (`venue.json`): see `kindFileWriters`. */
function kindFileRule(kind: Exclude<PageKind, 'paper'>): PathRule {
  const { kindFile, owners } = KINDS[kind];
  return {
    covers: (path) => path === kindFile,
    layout: fine,
    denied: (roles, path) => {
      if (kind === 'category') return may.verified(roles);
      if (roles.system) return METADATA_ONLY;
      return roles.owner || roles.admin || may.granted(roles, path)
        ? null
        : `only this ${kind}'s ${owners?.noun} and admins can change ${kindFile}`;
    },
  };
}

/**
 * A venue's forms (`forms.json`): what its source published about how to show its notes, so the system writes them as
 * it imports the venue's reviews, and admins and a bot granted the file may; its organisers don't.
 */
const VENUE_FORMS_RULE: PathRule = {
  covers: (path) => path === VENUE_FORMS_FILE,
  layout: fine,
  denied: (roles, path) =>
    roles.system || roles.admin || may.granted(roles, path)
      ? null
      : `only the system, admins and a bot granted ${VENUE_FORMS_FILE} change a venue's forms, as its source gives them`,
};

/** The rules of a paper's own files, beyond every kind's. */
const PAPER_RULES: PathRule[] = [
  {
    // What the paper is: the system writes it from the paper's source, then as its card, its confirmed authors' once
    // it is claimed and anyone verified's until then, so an import can name the authors when a review ends.
    covers: (path) => path === KINDS.paper.kindFile,
    layout: fine,
    denied: (roles) => {
      if (roles.system || roles.admin) return null;
      if (roles.claimed) return roles.owner ? null : "only this paper's confirmed authors can change its paper.json";
      return roles.verified ? null : CONFIRM;
    },
  },
  {
    covers: (path) => path.startsWith(`${VERSIONS_DIR}/`),
    layout: (path) =>
      versionIdOf(path) || versionPdfIdOf(path)
        ? null
        : 'versions/ holds a file per version, named like v_k3x9q2ab.json, and its PDF beside it as v_k3x9q2ab.pdf',
    // Facts about the paper that anyone verified can add to with evidence; the system writes them on import.
    denied: (roles) => (roles.system || roles.admin || roles.verified ? null : CONFIRM),
  },
  {
    // The paper's card: its confirmed authors' once it is claimed, and anyone verified's until then.
    covers: (path) => path === THUMBNAIL_PATH || thumbnailImageType(path) !== null || path.startsWith(`${LINKS_DIR}/`),
    layout: (path) =>
      !path.startsWith(`${LINKS_DIR}/`) || isLinkPath(path)
        ? null
        : 'links/ holds one file per link, named like 10-code.json',
    denied: (roles) => {
      if (roles.system) return METADATA_ONLY;
      if (roles.admin) return null;
      if (roles.claimed)
        return roles.owner ? null : "only this paper's confirmed authors can change its picture and links";
      return roles.verified ? null : CONFIRM;
    },
  },
  {
    // As the community section, since either section may show a demo. A folder the owners' section shows is its
    // owners' alone, which `commit.ts` checks, as it needs the sections' text.
    covers: isDemoPath,
    layout: (path) => {
      const demo = demoPath(path);
      if (!demo || !DEMO_NAME.test(demo.name) || demo.name.length > MAX_DEMO_NAME) {
        return 'demos/ holds one folder per demo, named like demos/my-demo/ (lower-case letters, digits and dashes)';
      }
      const dot = demo.inside.lastIndexOf('.');
      const extension = dot === -1 ? '' : demo.inside.slice(dot + 1);
      return DEMO_EXTENSIONS.has(extension)
        ? null
        : `a demo's files are text: ${[...DEMO_EXTENSIONS].map((e) => `.${e}`).join(' ')} (binary files come from GitHub)`;
    },
    denied: may.verified,
  },
  {
    // A source's imported submissions and reviews: only the bot granted the source writes them (DESIGN.md §4.3), so
    // what a page shows as a venue's reviews is what the venue published.
    covers: (path) => path.startsWith(`${REVIEWS_DIR}/`),
    layout: (path) => (parseReviewPath(path) ? null : REVIEWS_LAYOUT),
    denied: (roles, path) => {
      if (roles.admin || may.granted(roles, path)) return null;
      const source = reviewSourceOf(path);
      return `only the bot granted ${source ? `reviews/${source}/` : 'a source'} can change it, and admins`;
    },
  },
];

/** Why nothing is written to a person's page. */
export const NO_REPO = "a person's page has no files: it shows their profile, which they change at /profile";

/** Every rule of a kind's pages, in the order they are tried. */
function rulesOf(kind: PageKind): PathRule[] {
  const { owners, community } = KINDS[kind];
  // A person's page has no files (`KINDS.user.repo`): nobody, not even the system, writes one.
  if (!KINDS[kind].repo) return [{ covers: () => true, layout: () => NO_REPO, denied: () => NO_REPO }];
  const ownersRefusal = `only this ${kind}'s ${owners?.noun} can edit ${OWNERS_DIR}/`;
  const systemPaths = kind === 'paper' ? SYSTEM_PATHS : new Set([METADATA_PATH]);
  return [
    {
      covers: (path) =>
        path.startsWith(`${SYSTEM_DIR}/`) || path === GITATTRIBUTES_PATH || path === PREK_PATH || path === README_PATH,
      layout: (path) =>
        systemPaths.has(path) || path === GITATTRIBUTES_PATH || path === PREK_PATH || path === README_PATH
          ? null
          : kindLayout(kind),
      denied: may.system,
    },
    ...(owners ? [partRule(kind, OWNERS_DIR, may.owners(ownersRefusal))] : []),
    ...(community ? [partRule(kind, 'community', may.verified)] : []),
    ...(kind === 'paper' ? PAPER_RULES : [kindFileRule(kind)]),
    ...(kind === 'venue' ? [VENUE_FORMS_RULE] : []),
    // Data owned by one extension (DESIGN.md §10). Nobody can act as one until extensions exist.
    {
      covers: (path) => path.startsWith('extensions/'),
      layout: fine,
      denied: () => 'this path is reserved for extensions',
    },
  ];
}

const RULES = Object.fromEntries(PAGE_KINDS.map((kind) => [kind, rulesOf(kind)])) as Record<PageKind, PathRule[]>;

function ruleFor(path: string, kind: PageKind): PathRule | undefined {
  return RULES[kind].find((rule) => rule.covers(path));
}

/** Why nothing can be written at this path on a page of this kind, or `null`. Deleting a file needs no such check. */
export function layoutProblem(path: string, kind: PageKind = 'paper'): string | null {
  const rule = ruleFor(path, kind);
  return rule ? rule.layout(path) : kindLayout(kind);
}

export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_CHANGES = 50;
export const MAX_FILES = 1000;
/**
 * A bot's import of a busy forum can be hundreds of notes, so files under `reviews/` have limits of their own,
 * besides the others': per commit and per page.
 */
export const MAX_REVIEW_CHANGES = 1000;
export const MAX_REVIEW_FILES = 3000;

export function isReviewPath(path: string): boolean {
  return path.startsWith(`${REVIEWS_DIR}/`);
}
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
 * its spellings, `.gitmodules` and `.gitattributes`. The one exception is `.potentialpaper` at the top,
 * spelled exactly so, which keeps the system's files out of the way of people's, and `.gitattributes` at the
 * top, whose content is fixed (`GITATTRIBUTES`).
 */
function nameProblem(name: string, top: boolean, alone: boolean): string | null {
  if (name === '') return 'has an empty name';
  const allowed = (top && name === SYSTEM_DIR) || (alone && name === GITATTRIBUTES_PATH);
  if (name.startsWith('.') && !allowed) return 'has a name starting with a dot';
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
  for (const [index, name] of names.entries()) {
    const problem = nameProblem(name, index === 0 && names.length > 1, names.length === 1);
    if (problem) return { problem };
  }
  return { path };
}

export interface Roles {
  system: boolean;
  admin: boolean;
  /** Has a confirmed institutional address, or is a bot an operator minted. */
  verified: boolean;
  /**
   * One of the page's owners: a confirmed author of a paper (`author_claims`), a confirmed organiser of a venue, a
   * verified member of an org, the account a user page is (`server/pages/kinds.ts`'s `rolesOf`).
   */
  owner: boolean;
  /** The page has a confirmed owner: a paper's confirmed author then owns its picture and links. */
  claimed: boolean;
  /** A bot's write grants (`bot_grants`) on pages of this kind: path patterns such as `reviews/openreview/**`. */
  grants?: readonly string[];
}

/**
 * Whether a grant's pattern covers a path: `<folder>/**` covers everything under the folder, and any other
 * pattern only the path it spells.
 */
export function grantCovers(pattern: string, path: string): boolean {
  return pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path;
}

/**
 * Why a bot can't be granted this pattern on pages of this kind, or `null`. On papers, a source's folder of imported
 * reviews, `reviews/<source>/**`; on venues and orgs, the kind file (the `venues` and `orgs` bots of
 * `handoffs/pages.md`), and on venues also their forms; no bot writes category or user pages. Extensions' folders come
 * with them (DESIGN.md §10).
 */
export function grantProblem(pattern: string, kind: PageKind = 'paper'): string | null {
  if (kind === 'venue') {
    return pattern === KINDS.venue.kindFile || pattern === VENUE_FORMS_FILE
      ? null
      : `on venue pages a bot can be granted ${KINDS.venue.kindFile} or ${VENUE_FORMS_FILE}`;
  }
  if (kind === 'org') {
    return pattern === KINDS[kind].kindFile ? null : `on ${kind} pages a bot can be granted ${KINDS[kind].kindFile}`;
  }
  if (kind !== 'paper') return `no bot writes ${kind} pages`;
  const match = /^reviews\/([^/]+)\/\*\*$/.exec(pattern);
  if (!match || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(match[1]) || match[1].length > 40) {
    return "a grant is a source's folder of reviews, like reviews/openreview/** (the source a lower-case slug)";
  }
  return null;
}

/**
 * Why these roles cannot write this path on a page of this kind, or `null`. Checked for each path of a commit. Admins
 * may write anything but the system's files' fixed content and a person's profile.
 */
export function pathDenied(path: string, roles: Roles, kind: PageKind = 'paper'): string | null {
  const rule = ruleFor(path, kind);
  return rule ? rule.denied(roles, path) : kindLayout(kind);
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

/** The paper's PDF as a page shows it: its newest version's (`lib/versions.ts`, `paperPdfOf`). */
export type PdfPointer = VersionPdf;

export const THUMBNAIL_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'] as const;
export type ThumbnailType = (typeof THUMBNAIL_TYPES)[number];
/** It shows in a 300px box: an animated GIF larger than this is a mistake, and slows every reader. */
export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;
/** Of the alt text and of the caption. */
const MAX_ALT_LENGTH = 500;

export interface ThumbnailPointer {
  sha256: string;
  bytes: number;
  type: ThumbnailType;
  /** Where the bytes are: `https:`, or a path on this site in development. */
  url: string;
  /** What it shows, for a reader who can't see it. */
  alt?: string;
  /** The figure's caption, after "Figure 1:". */
  caption?: string;
}

/** An image's type from its first bytes, or `null` if it isn't one a thumbnail can be. */
export function imageType(bytes: Uint8Array): ThumbnailType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return 'image/avif';
  return null;
}

export type ThumbnailWords = Pick<ThumbnailPointer, 'alt' | 'caption'>;

/**
 * A `thumbnail.json`: the one definition, which both checks the file and is its JSON Schema (`schemas.ts`).
 */
export const thumbnailWordsSchema = z
  .strictObject({
    alt: z
      .string()
      .max(MAX_ALT_LENGTH)
      .optional()
      .meta({ description: "What the picture shows, for a reader who can't see it." }),
    caption: z
      .string()
      .max(MAX_ALT_LENGTH)
      .optional()
      .meta({ description: 'The caption under the picture, after "Figure 1:".' }),
  })
  .meta({
    title: 'Picture',
    description:
      "The words for the paper's picture, thumbnail.png (or .jpg, .gif, .webp, .avif) beside this file. Both optional.",
  });

/** The words in a `thumbnail.json`, or `null` if it isn't that. */
export function parseThumbnailWords(text: string): ThumbnailWords | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = thumbnailWordsSchema.safeParse(value);
  if (!parsed.success) return null;
  const { alt, caption } = parsed.data;
  return { ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) };
}

export function encodeThumbnailWords({ alt, caption }: ThumbnailWords): string {
  return `${JSON.stringify({ ...(alt ? { alt } : {}), ...(caption ? { caption } : {}) }, null, 2)}\n`;
}

/** What to tell someone whose PDF or picture arrived as itself, not as a Git LFS pointer. */
export const LFS_NEEDED =
  'has to be a Git LFS pointer: install Git LFS (https://git-lfs.com), run `git lfs install` once, then ' +
  '`git rm --cached <file>`, `git add <file>` and commit again';

/**
 * Why this can't be the file's content, or `null`. Files are text, since media goes to R2 (DESIGN.md
 * §4.3). Checked after merging as well, because two valid edits can merge into invalid JSON. Rules that
 * span files (how many links, their labels) are `commit.ts`'s, which sees the whole tree.
 */
export function contentProblem(path: string, content: string, kind: PageKind = 'paper'): string | null {
  // A PDF or picture that arrived as itself rather than as a pointer is told how to fix that.
  const lfs = lfsKindOf(path);
  if (lfs) {
    const pointer = parseLfsPointer(content);
    if (!pointer) return LFS_NEEDED;
    const max = lfs === 'pdf' ? MAX_POINTED_PDF_BYTES : MAX_THUMBNAIL_BYTES;
    return pointer.bytes > max ? `is larger than ${max / 1024 / 1024} MB` : null;
  }
  if (!content.isWellFormed()) return 'is not valid Unicode';
  if (content.includes('\0')) return 'is not text';
  // A demo's files are its own code, served as they are from the demo host: only their size is ours.
  if (isDemoPath(path)) {
    return Buffer.byteLength(content) > MAX_DEMO_FILE_BYTES ? `is larger than ${MAX_DEMO_FILE_BYTES} bytes` : null;
  }
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) return `is larger than ${MAX_FILE_BYTES} bytes`;
  if (path === GITATTRIBUTES_PATH) return content === GITATTRIBUTES ? null : 'is the same on every page, and fixed';
  if (isLabeledLinksPath(path, kind)) {
    const parsed = parseLabeledLinks(content, kind);
    return 'problem' in parsed ? parsed.problem : null;
  }
  if (isFactsPath(path, kind)) {
    const parsed = parseFacts(content, kind);
    return 'problem' in parsed ? parsed.problem : null;
  }
  if (kind === 'paper' && path === AUTHOR_PLUGINS_PATH) {
    const parsed = parseAuthorPlugins(content);
    return 'problem' in parsed ? parsed.problem : null;
  }
  const part = partOf(path, kind);
  if (part && path.endsWith('.html')) return htmlProblem(content);
  if (kind !== 'paper') {
    const { kindFile, kindFileSchema } = KINDS[kind];
    if (path === kindFile && kindFileSchema) {
      const problem = jsonProblem(content, true);
      if (problem) return problem;
      const parsed = kindFileSchema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return `is not a ${kindFile}: ${issue.path.join('.') || 'it'}: ${issue.message}`;
      }
      return null;
    }
    if (path === METADATA_PATH) return kindMetadataProblem(content, kind);
    if (kind === 'venue' && path === VENUE_FORMS_FILE) {
      const parsed = parseVenueFormsFile(content);
      return 'problem' in parsed ? parsed.problem : null;
    }
    return path.endsWith('.json') ? jsonProblem(content, false) : null;
  }
  if (path === THUMBNAIL_PATH) {
    return parseThumbnailWords(content) ? null : 'is not { "alt": "…", "caption": "…" } (both optional)';
  }
  if (isLinkPath(path)) return parseLinkFile(content) ? null : 'is not a link: { "label": "Code", "url": "https://…" }';
  const review = parseReviewPath(path);
  if (review) {
    const parsed = parseReviewFile(review.kind, content);
    return 'problem' in parsed ? parsed.problem : null;
  }
  const versionId = versionIdOf(path);
  if (versionId) {
    const parsed = parseVersionFile(versionId, content);
    return 'problem' in parsed ? parsed.problem : null;
  }
  if (path === METADATA_PATH) {
    const problem = jsonProblem(content, true);
    if (problem) return problem;
    const { layout } = JSON.parse(content) as { layout?: unknown };
    if (layout !== undefined && layoutVersionOf(content) === null)
      return 'has a "layout" that is not a version (1, 2, …)';
    return null;
  }
  if (path.endsWith('.json')) return jsonProblem(content, false);
  return null;
}

/**
 * The `.potentialpaper/metadata.json` of a page of a kind other than a paper: what its first commit wrote
 * (`server/pages/kinds.ts`), `{ "layout", "kind", "key" }`, whose kind has to be the page's.
 */
function kindMetadataProblem(content: string, kind: PageKind): string | null {
  const problem = jsonProblem(content, true);
  if (problem) return problem;
  const value = JSON.parse(content) as { kind?: unknown; layout?: unknown };
  if (value.kind !== kind) return `has to say "kind": "${kind}"`;
  if (value.layout !== undefined && layoutVersionOf(content) === null) return 'has a "layout" that is not a version';
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
