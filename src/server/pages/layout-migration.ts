import { linkProblem, type TitleLink } from '@/lib/paper-links';
import type { PaperVersion } from '@/lib/versions';
import type { FileChange } from './commit';
import { linkChanges, versionChanges } from './content';
import { shiftHeadings, splitSections } from './markdown';
import { layoutProblem, METADATA_PATH, PAGE_PARTS, PDF_PATH } from './rules';
import { planSections } from './sections';

/**
 * From the first layout (one `page.md` per part, `links.json`, `versions.jsonl`, the system's files at the
 * top) to files and folders (`rules.ts`). Pure: `scripts/migrate-page-layout.ts` commits what this says, as
 * the system, a commit per page.
 */

const MOVED: Record<string, string> = { 'metadata.json': METADATA_PATH, 'pdf.json': PDF_PATH };
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
      changes.push({ path, content: null }, { path: MOVED[path], content: text });
    } else if (path === OLD_LINKS) {
      changes.push({ path, content: null }, ...linkChanges([], oldLinks(text)));
    } else if (path === OLD_VERSIONS) {
      changes.push({ path, content: null }, ...versionChanges([], oldVersions(text)));
    } else if (DROPPED.has(path)) {
      changes.push({ path, content: null });
    } else if (PAGE_PARTS.some((part) => path === `${part}/page.md`)) {
      const part = PAGE_PARTS.find((p) => path === `${p}/page.md`)!;
      // Sections were `##` headings; now each is a file whose title is its `#` heading.
      const parts = splitSections(shiftHeadings(text, -1)).map((section) => ({
        title: section.title ?? 'Introduction',
        text: section.text,
      }));
      changes.push({ path, content: null }, ...planSections([], part, 0, 0, parts));
    } else if (layoutProblem(path)) {
      left.push(path);
    }
  }
  return { changes, left };
}
