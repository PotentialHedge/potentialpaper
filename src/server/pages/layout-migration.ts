import { linkProblem, type TitleLink } from '@/lib/paper-links';
import { encodeVersionFile, parseVersionFile, type PaperVersion } from '@/lib/versions';
import { OWNERS_DIR, type PageKind } from '@/lib/kinds';
import type { FileChange } from './commit';
import { linkChanges, versionChanges } from './content';
import { shiftHeadings, splitSections } from './markdown';
import {
  encodeLfsPointer,
  encodeThumbnailWords,
  GITATTRIBUTES,
  GITATTRIBUTES_PATH,
  layoutProblem,
  layoutVersionOf,
  METADATA_PATH,
  PDF_TYPE,
  THUMBNAIL_PATH,
  THUMBNAIL_TYPES,
  thumbnailImagePath,
  versionIdOf,
  versionPdfPath,
  withLayoutVersion,
} from './rules';
import { planSections } from './sections';

/**
 * From the first layout (one `page.md` per part, `links.json`, `versions.jsonl`, the system's files at the
 * top) to files and folders (`rules.ts`), layout 2, which `metadata.json` then records. Pure:
 * `scripts/migrate-page-layout.ts` commits what this says, as the system, a commit per page.
 */

/** The paper's own PDF and where it came from, from layout 2 until layout 5 made every PDF a version's. */
const PAPER_PDF_PATH = '.potentialpaper/paper.pdf';
const PDF_PATH = '.potentialpaper/pdf.json';

const MOVED: Record<string, string> = { 'metadata.json': METADATA_PATH, 'pdf.json': PDF_PATH };
/** A paper's parts in the first layout, before layout 4 named the owners' `owners/`. */
const FIRST_PARTS = ['author', 'community'] as const;
const OLD_LINKS = 'links.json';
const OLD_VERSIONS = 'versions.jsonl';
/** Reserved in the first layout and never written; links say the same now. */
const DROPPED = new Set(['author/resources.json']);

export interface LayoutPlan {
  changes: FileChange[];
  /** Files the new layout has no place for, which stay where they are. */
  left: string[];
}

function oldLinks(text: string): TitleLink[] {
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .map((item: { label?: unknown; url?: unknown }) => ({
        label: String(item?.label ?? '').trim(),
        url: String(item?.url ?? ''),
      }))
      .filter((link) => !linkProblem(link));
  } catch {
    return [];
  }
}

function oldVersions(text: string): PaperVersion[] {
  const out: PaperVersion[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as PaperVersion);
    } catch {
      // A line that never parsed was never shown either.
    }
  }
  return out;
}

/** The changes that move a page's files, given as path to text, to the new layout. None if it is there. */
export function planLayout(files: ReadonlyMap<string, string>): LayoutPlan {
  const changes: FileChange[] = [];
  const left: string[] = [];
  for (const [path, text] of files) {
    if (MOVED[path]) {
      const content = MOVED[path] === METADATA_PATH ? (withLayoutVersion(text, 2) ?? text) : text;
      changes.push({ path, content: null }, { path: MOVED[path], content });
    } else if (path === OLD_LINKS) {
      changes.push({ path, content: null }, ...linkChanges([], oldLinks(text)));
    } else if (path === OLD_VERSIONS) {
      changes.push({ path, content: null }, ...versionChanges([], oldVersions(text)));
    } else if (DROPPED.has(path)) {
      changes.push({ path, content: null });
    } else if (FIRST_PARTS.some((part) => path === `${part}/page.md`)) {
      const part = FIRST_PARTS.find((p) => path === `${p}/page.md`)!;
      // Sections were `##` headings; now each is a file whose title is its `#` heading.
      const parts = splitSections(shiftHeadings(text, -1)).map((section) => ({
        title: section.title ?? 'Introduction',
        text: section.text,
      }));
      changes.push({ path, content: null }, ...planSections([], part, 0, 0, parts));
    } else if (layoutProblem(path) && !path.startsWith('author/')) {
      left.push(path);
    }
  }
  return { changes, left };
}

/** A file this site stored, named by an old pointer, which the move to Git LFS records (`server/lfs.ts`). */
export interface StoredFile {
  sha256: string;
  bytes: number;
  type: string;
  url: string;
}

export interface LfsPlan {
  changes: FileChange[];
  /** The files the new pointers name, to record in `lfs_objects` before committing. */
  stored: StoredFile[];
}

const SHA256 = /^[0-9a-f]{64}$/;

function oldPointer(value: unknown): StoredFile | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { sha256, bytes, url, type } = value as Record<string, unknown>;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null;
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 || typeof url !== 'string') return null;
  return { sha256, bytes, url, type: typeof type === 'string' ? type : PDF_TYPE };
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text ?? '') as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * From pointers in JSON (`pdf.json`, `thumbnail.json`, a version's `"pdf"` with its hash and address) to Git
 * LFS (`rules.ts`): the PDF as `.potentialpaper/paper.pdf`, the picture as `thumbnail.<ext>`, a version's PDF as
 * `versions/<id>.pdf`, each a pointer, with what else the JSON said left in it; `.gitattributes`; and layout 3
 * in `metadata.json`. Pure: `scripts/migrate-page-lfs.ts` records the files and commits what this says. None
 * if the page is there.
 */
export function planLfs(files: ReadonlyMap<string, string>): LfsPlan {
  const changes: FileChange[] = [];
  const stored: StoredFile[] = [];
  if (!files.has(GITATTRIBUTES_PATH)) changes.push({ path: GITATTRIBUTES_PATH, content: GITATTRIBUTES });
  const metadata = files.get(METADATA_PATH);
  const stamped = metadata !== undefined && (layoutVersionOf(metadata) ?? 0) < 3 && withLayoutVersion(metadata, 3);
  if (stamped) changes.push({ path: METADATA_PATH, content: stamped });

  const pdf = parseJson(files.get(PDF_PATH));
  const pdfFile = pdf && oldPointer(pdf);
  if (pdf && pdfFile && typeof pdf.source === 'string' && typeof pdf.license === 'string') {
    stored.push({ ...pdfFile, type: PDF_TYPE });
    changes.push(
      { path: PAPER_PDF_PATH, content: encodeLfsPointer(pdfFile) },
      {
        path: PDF_PATH,
        content: `${JSON.stringify({ source: pdf.source, license: pdf.license, fetchedAt: String(pdf.fetchedAt ?? '') }, null, 2)}\n`,
      },
    );
  }

  const thumbnail = parseJson(files.get(THUMBNAIL_PATH));
  const picture = thumbnail && oldPointer(thumbnail);
  const type = picture && THUMBNAIL_TYPES.find((t) => t === picture.type);
  if (thumbnail && picture && type) {
    stored.push(picture);
    const alt = typeof thumbnail.alt === 'string' ? thumbnail.alt : undefined;
    const caption = typeof thumbnail.caption === 'string' ? thumbnail.caption : undefined;
    changes.push(
      { path: thumbnailImagePath(type), content: encodeLfsPointer(picture) },
      { path: THUMBNAIL_PATH, content: alt || caption ? encodeThumbnailWords({ alt, caption }) : null },
    );
  }

  for (const [path, text] of files) {
    const id = versionIdOf(path);
    const version = id ? parseJson(text) : null;
    const file = version && oldPointer(version.pdf);
    if (!id || !version || !file) continue;
    const { source, license } = version.pdf as { source?: unknown; license?: unknown };
    const info = {
      ...(typeof source === 'string' ? { source } : {}),
      ...(typeof license === 'string' ? { license } : {}),
    };
    const { pdf: _old, ...rest } = version;
    void _old;
    const ordered = parseVersionFile(id, JSON.stringify(Object.keys(info).length > 0 ? { ...rest, pdf: info } : rest));
    if (!('version' in ordered)) continue;
    stored.push({ ...file, type: PDF_TYPE });
    changes.push(
      { path, content: encodeVersionFile({ ...ordered.version, pdf: { ...file, ...info } }) },
      { path: versionPdfPath(id), content: encodeLfsPointer(file) },
    );
  }
  return { changes, stored };
}

/** The owners' folder each kind had before layout 4. */
const OLD_OWNERS: Record<PageKind, string | null> = {
  paper: 'author',
  venue: 'organizers',
  org: 'members',
  user: 'about',
  topic: null,
};

/**
 * To layout 4: the owners' part moved from the folder its kind had (`author/`, `organizers/`, `members/`, `about/`) to
 * `owners/`, as it is on every kind now, and layout 4 in `metadata.json`. Pure: `scripts/migrate-page-owners.ts`
 * commits what this says. None if the page is there.
 */
export function planOwners(kind: PageKind, files: ReadonlyMap<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const metadata = files.get(METADATA_PATH);
  if (metadata === undefined || (layoutVersionOf(metadata) ?? 0) >= 4) return changes;
  const old = OLD_OWNERS[kind];
  for (const [path, text] of files) {
    if (old && path.startsWith(`${old}/`)) {
      changes.push({ path, content: null }, { path: `${OWNERS_DIR}/${path.slice(old.length + 1)}`, content: text });
    }
  }
  const stamped = withLayoutVersion(metadata, 4);
  if (stamped) changes.push({ path: METADATA_PATH, content: stamped });
  return changes;
}
