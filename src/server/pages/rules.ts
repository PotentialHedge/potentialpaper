import { z } from 'zod';
import { DEMO_NAME, DEMOS_DIR, MAX_DEMO_NAME } from '@/lib/demos';
import { parseLinkFile } from '@/lib/paper-links';
import { parseReviewPath, parseReviewFile, REVIEWS_DIR, reviewSourceOf } from '@/lib/review-files';
import { parseVersionFile, VERSION_ID } from '@/lib/versions';
import { htmlProblem } from './html';

/**
 * What may be written to a page repo, and by whom (DESIGN.md §4.3). Pure, and the only place these rules
 * are decided. Paths reach people's disks through `git clone`, so a path has to be safe on every
 * filesystem as well as valid to git. The layout is many small files a person can edit with a text editor:
 *
 *   .gitattributes                  the system's, always the same: which files are kept with Git LFS
 *   prek.toml                       the system's, always the same: checks to run before a commit
 *   .potentialpaper/metadata.json   the system's: identifiers, title, authors, abstract snapshot
 *   .potentialpaper/paper.pdf       the system's: the paper's PDF (Git LFS)
 *   .potentialpaper/pdf.json        the system's: where that PDF came from, and its license
 *   author/10-overview.md           the author section, a file per section (Markdown or HTML)
 *   community/10-summary.md         the community section, the same way
 *   versions/v_k3x9q2ab.json        a version of the paper, named by its id
 *   versions/v_k3x9q2ab.pdf         that version's PDF (Git LFS)
 *   links/10-code.json              a link under the title
 *   thumbnail.png                   the paper's picture (Git LFS), or .jpg, .gif, .webp, .avif
 *   thumbnail.json                  its alt text and caption
 *   demos/<name>/index.html         a demo, with its other files beside it
 *   reviews/<source>/<submission>/  a bot's import of a submission and its notes (`lib/review-files.ts`)
 *   extensions/<id>/…               reserved
 *
 * PDFs and pictures are Git LFS pointers (`parseLfsPointer`): the repo holds their hash and size, the bytes
 * are in R2 (`server/lfs.ts`), and `git lfs` moves them through the batch API (`server/git/lfs.ts`).
 */

/** Files only the system and admins write. The one directory whose name may start with a dot. */
export const SYSTEM_DIR = '.potentialpaper';
export const METADATA_PATH = `${SYSTEM_DIR}/metadata.json`;
/** The paper's PDF, a Git LFS pointer; the bytes are in R2 (DESIGN.md §4.3). */
export const PAPER_PDF_PATH = `${SYSTEM_DIR}/paper.pdf`;
/** Where `paper.pdf` came from and under what license, which the license requires us to say. */
export const PDF_PATH = `${SYSTEM_DIR}/pdf.json`;
const SYSTEM_PATHS = new Set([METADATA_PATH, PAPER_PDF_PATH, PDF_PATH]);

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

/** The two parts of a page written as prose, each a directory of section files. */
export type PagePart = 'author' | 'community';
export const PAGE_PARTS: readonly PagePart[] = ['author', 'community'];

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
  if (path === PAPER_PDF_PATH || versionPdfIdOf(path)) return 'pdf';
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

/** What a page holds, said when a path isn't one of them. */
const LAYOUT =
  'pages hold .gitattributes, prek.toml, .potentialpaper/ (metadata.json, paper.pdf, pdf.json), author/ and community/ ' +
  '(sections named like 10-summary.md or 20-results.html), versions/<id>.json and <id>.pdf, links/ (named like ' +
  '10-code.json), thumbnail.png (or .jpg, .gif, .webp, .avif) and thumbnail.json, demos/<name>/, ' +
  'reviews/<source>/<submission>/ and extensions/';

const REVIEWS_LAYOUT =
  'reviews/<source>/<submission>/ holds submission.json, forms.json and notes/<id>.json, each name a lower-case ' +
  'slug (letters, digits, - and _)';

/** Why nothing can be written at this path, or `null`. Deleting a file needs no such check. */
export function layoutProblem(path: string): string | null {
  if (SYSTEM_PATHS.has(path) || path === GITATTRIBUTES_PATH || path === PREK_PATH || path === THUMBNAIL_PATH) {
    return null;
  }
  if (thumbnailImageType(path)) return null;
  if (path.startsWith('extensions/')) return null;
  if (path.startsWith(`${REVIEWS_DIR}/`)) return parseReviewPath(path) ? null : REVIEWS_LAYOUT;
  for (const part of PAGE_PARTS) {
    if (path.startsWith(`${part}/`)) {
      return sectionName(path, part)
        ? null
        : `${part}/ holds one file per section, named like 10-summary.md or 20-results.html (two digits, a lower-case slug)`;
    }
  }
  if (path.startsWith(`${LINKS_DIR}/`)) {
    return isLinkPath(path) ? null : 'links/ holds one file per link, named like 10-code.json';
  }
  if (path.startsWith(`${VERSIONS_DIR}/`)) {
    return versionIdOf(path) || versionPdfIdOf(path)
      ? null
      : 'versions/ holds a file per version, named like v_k3x9q2ab.json, and its PDF beside it as v_k3x9q2ab.pdf';
  }
  if (isDemoPath(path)) {
    const demo = demoPath(path);
    if (!demo || !DEMO_NAME.test(demo.name) || demo.name.length > MAX_DEMO_NAME) {
      return 'demos/ holds one folder per demo, named like demos/my-demo/ (lower-case letters, digits and dashes)';
    }
    const dot = demo.inside.lastIndexOf('.');
    const extension = dot === -1 ? '' : demo.inside.slice(dot + 1);
    if (!DEMO_EXTENSIONS.has(extension)) {
      return `a demo's files are text: ${[...DEMO_EXTENSIONS].map((e) => `.${e}`).join(' ')} (binary files come from GitHub)`;
    }
    return null;
  }
  return LAYOUT;
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
  /** A confirmed author of this paper (`author_claims`). */
  confirmedAuthor: boolean;
  /** The paper has a confirmed author, who then owns its picture and links. */
  claimed: boolean;
  /** A bot's write grants (`bot_grants`): path patterns such as `reviews/openreview/**`. */
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
 * Why a bot can't be granted this pattern, or `null`. For now only a source's folder of imported reviews,
 * `reviews/<source>/**`; extensions' folders come with them (DESIGN.md §10).
 */
export function grantProblem(pattern: string): string | null {
  const match = /^reviews\/([^/]+)\/\*\*$/.exec(pattern);
  if (!match || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(match[1]) || match[1].length > 40) {
    return "a grant is a source's folder of reviews, like reviews/openreview/** (the source a lower-case slug)";
  }
  return null;
}

/** Why these roles cannot write this path, or `null`. Checked for each path of a commit. */
export function pathDenied(path: string, roles: Roles): string | null {
  if (path.startsWith(`${SYSTEM_DIR}/`) || path === GITATTRIBUTES_PATH || path === PREK_PATH) {
    return roles.system || roles.admin ? null : `only the system and admins can change ${SYSTEM_DIR}/`;
  }
  if (path.startsWith(`${VERSIONS_DIR}/`)) {
    return roles.system || roles.admin || roles.verified ? null : 'confirm an institutional email address first';
  }
  if (path === THUMBNAIL_PATH || thumbnailImageType(path) || path.startsWith(`${LINKS_DIR}/`)) {
    if (roles.system) return 'the system only writes the metadata';
    if (roles.admin) return null;
    if (roles.claimed)
      return roles.confirmedAuthor ? null : "only this paper's confirmed authors can change its picture and links";
    return roles.verified ? null : 'confirm an institutional email address first';
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
  // As the community section, since either section may show a demo. A folder the author section shows is
  // its authors' alone, which `commit.ts` checks, as it needs the sections' text.
  if (isDemoPath(path)) {
    if (roles.system) return 'the system only writes the metadata';
    return roles.verified || roles.admin ? null : 'confirm an institutional email address first';
  }
  // A source's imported submissions and reviews: only the bot granted the source writes them (DESIGN.md §4.3),
  // so what a page shows as a venue's reviews is what the venue published.
  if (path.startsWith(`${REVIEWS_DIR}/`)) {
    if (roles.admin) return null;
    if (roles.grants?.some((pattern) => grantCovers(pattern, path))) return null;
    const source = reviewSourceOf(path);
    return `only the bot granted ${source ? `reviews/${source}/` : 'a source'} can change it, and admins`;
  }
  // Data owned by one extension (DESIGN.md §10). Nobody can act as one until extensions exist.
  if (path.startsWith('extensions/')) return 'this path is reserved for extensions';
  return LAYOUT;
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

export interface PdfPointer {
  sha256: string;
  bytes: number;
  /** Where the bytes are. */
  url: string;
  /** The page it was copied from, which the license requires us to credit. */
  source: string;
  license: string;
  fetchedAt: string;
}

/** What `pdf.json` says about `paper.pdf`. */
export type PdfSource = Pick<PdfPointer, 'source' | 'license' | 'fetchedAt'>;

/**
 * A `.potentialpaper/pdf.json`: the one definition, which both checks the file and is its JSON Schema
 * (`schemas.ts`). Pages credit `source`, so it has to be checked.
 */
export const pdfSourceSchema = z
  .strictObject({
    source: z
      .url({ protocol: /^https$/ })
      .meta({ description: 'The page the PDF was copied from, which the license requires us to credit.' }),
    license: z.string().min(1).meta({ description: 'The license it was copied under, such as "CC BY 4.0".' }),
    fetchedAt: z.string().meta({ description: 'When it was copied (ISO 8601).' }),
  })
  .meta({ title: 'Paper PDF', description: 'Where .potentialpaper/paper.pdf came from. Written by the system.' });

/** A `pdf.json`, or `null` if it isn't one. */
export function parsePdfSource(text: string): PdfSource | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = pdfSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function encodePdfSource({ source, license, fetchedAt }: PdfSource): string {
  return `${JSON.stringify({ source, license, fetchedAt }, null, 2)}\n`;
}

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
export function contentProblem(path: string, content: string): string | null {
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
  if (path === PDF_PATH) {
    return parsePdfSource(content) ? null : 'is not { "source": "https://…", "license": "…", "fetchedAt": "…" }';
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
  if (path.endsWith('.html') && (path.startsWith('author/') || path.startsWith('community/'))) {
    return htmlProblem(content);
  }
  if (path.endsWith('.json')) return jsonProblem(content, path === METADATA_PATH);
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
