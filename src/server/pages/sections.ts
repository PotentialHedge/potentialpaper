import type { DemoSource } from '@/lib/demos';
import { ApiError } from '../api/errors';
import type { FileChange } from './commit';
import { leadingHtmlTitle, renderHtmlSection } from './html';
import { asBlock, leadingTitle, renderMarkdown, shiftHeadings, type SectionText } from './markdown';
import { readText, type Reader } from './repo';
import { MAX_SECTIONS, type OrderedName, type PagePart, type SectionFormat, sectionName } from './rules';

/**
 * A part of a page (author or community) as its section files: `community/10-summary.md`,
 * `community/20-why-it-matters.md`, … in the order of their names. Editing a section is editing its file;
 * editing the whole part, or typing a new `#` heading into a section, makes, removes or renumbers files
 * (`planSections`).
 */

export interface SectionFile {
  path: string;
  name: OrderedName & { format: SectionFormat };
  text: string;
}

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The part's section paths in a tree, in the order they show. */
export function sectionPaths(files: Iterable<string>, part: PagePart): string[] {
  return [...files].filter((path) => sectionName(path, part)).sort(byBytes);
}

/**
 * The part's sections in a tree, in order, as the page shows them: a blank file is a section nobody has
 * written yet (every page starts with some, `starter.ts`), so it isn't one.
 */
export async function readSections(
  db: Reader,
  pageId: string,
  files: ReadonlyMap<string, string>,
  part: PagePart,
): Promise<SectionFile[]> {
  const out: SectionFile[] = [];
  for (const path of sectionPaths(files.keys(), part)) {
    const text = (await readText(db, pageId, files.get(path))) ?? '';
    if (text.trim() !== '') out.push({ path, name: sectionName(path, part)!, text });
  }
  return out;
}

/** `why-it-matters` as a heading: "Why it matters". */
/** Titles a slug can't spell, as they are written: `tl-dr` is "TL;DR". */
const SLUG_TITLES: Record<string, string> = { 'tl-dr': 'TL;DR' };

export function slugTitle(slug: string): string {
  if (SLUG_TITLES[slug]) return SLUG_TITLES[slug];
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A file name's slug for a title: "Code and data" is `code-and-data`. */
export function slugOf(title: string | null): string {
  const slug = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'section';
}

/** What the section is called: its leading heading, or else its file name. */
export function sectionTitle(section: SectionFile): string {
  const title = section.name.format === 'markdown' ? leadingTitle(section.text) : leadingHtmlTitle(section.text);
  return title ?? slugTitle(section.name.slug);
}

/** The part as the page shows it, or `null` if it has no sections. Each file is section `n`, from 1. */
export function renderPart(
  sections: readonly SectionFile[],
  idPrefix: string,
  demos?: ReadonlyMap<string, DemoSource>,
): string | null {
  if (sections.length === 0) return null;
  return sections
    .map((section, i) => {
      const title = slugTitle(section.name.slug);
      return section.name.format === 'markdown'
        ? renderMarkdown(section.text, idPrefix, { demos, section: { index: i + 1, title } })
        : renderHtmlSection(section.text, idPrefix, i + 1, title);
    })
    .join('');
}

/**
 * The part's files as one text, for an agent to read under the part's own `##` heading, so each section's
 * `#` is a `###`; or `null`. HTML sections are in it as they are.
 */
export function partSource(sections: readonly SectionFile[]): string | null {
  return sections.length === 0 ? null : shiftHeadings(joinSections(sections), 2);
}

/**
 * The part as one Markdown text, which the whole-part editor opens with and `planSections` splits back
 * apart. A file without a heading gets its file name's, so that it stays a section of its own.
 */
export function joinSections(sections: readonly SectionFile[]): string {
  return sections
    .map((section) => {
      const text = asBlock(section.text);
      const titled = section.name.format === 'html' || leadingTitle(text) !== null;
      return titled ? text : `# ${slugTitle(section.name.slug)}\n\n${text}`;
    })
    .join('\n');
}

interface Planned {
  old?: SectionFile;
  slug: string;
  format: SectionFormat;
  text: string;
}

const pad = (order: number) => String(order).padStart(2, '0');
const extension = (format: SectionFormat) => (format === 'markdown' ? 'md' : 'html');

/**
 * Orders for the planned files: kept files keep theirs, new ones go between their neighbours, and if a
 * file was moved, or there is no room between, every file is numbered again, in tens where they fit.
 */
function orders(planned: readonly Planned[]): number[] {
  const kept = planned.filter((item) => item.old).map((item) => item.old!.path);
  const inOrder = kept.every((path, i) => i === 0 || byBytes(kept[i - 1], path) < 0);
  if (inOrder) {
    const out: number[] = [];
    let at = 0;
    let fits = true;
    while (at < planned.length) {
      if (planned[at].old) {
        out.push(planned[at].old!.name.order);
        at += 1;
        continue;
      }
      let end = at;
      while (end < planned.length && !planned[end].old) end += 1;
      const before = at === 0 ? 0 : out[at - 1];
      const after = end < planned.length ? planned[end].old!.name.order : null;
      const count = end - at;
      if (after === null && before + 10 * count <= 99) {
        for (let j = 1; j <= count; j += 1) out.push(before + 10 * j);
      } else {
        const top = after ?? 100;
        if (top - before - 1 < count) {
          fits = false;
          break;
        }
        const step = (top - before) / (count + 1);
        for (let j = 1; j <= count; j += 1) out.push(before + Math.floor(step * j));
      }
      at = end;
    }
    if (fits) return out;
  }
  const step = Math.min(10, Math.floor(99 / planned.length));
  return planned.map((_, i) => step * (i + 1));
}

/**
 * The changes that replace sections `from` to `to` (exclusive, from 0) with `parts`. A part keeps the
 * file whose title it has, or else the next file it replaces, so an edit to one section changes one file;
 * the rest of the replaced files go, and parts left over become new files after their neighbours.
 */
export function planSections(
  existing: readonly SectionFile[],
  part: PagePart,
  from: number,
  to: number,
  parts: readonly (SectionText & { format?: SectionFormat })[],
): FileChange[] {
  const replaced = existing.slice(from, to);
  const wanted = parts.map((p) => ({ ...p, text: asBlock(p.text) })).filter((p) => p.text !== '');
  const used = new Set<SectionFile>();
  const match: (SectionFile | undefined)[] = wanted.map((p) => {
    const found = replaced.find((file) => !used.has(file) && p.title !== null && sectionTitle(file) === p.title);
    if (found) used.add(found);
    return found;
  });
  for (const [i] of wanted.entries()) {
    if (match[i]) continue;
    match[i] = replaced.find((file) => !used.has(file));
    if (match[i]) used.add(match[i]!);
  }

  const keep = (file: SectionFile): Planned => ({
    old: file,
    slug: file.name.slug,
    format: file.name.format,
    text: file.text,
  });
  const planned: Planned[] = [
    ...existing.slice(0, from).map(keep),
    ...wanted.map((p, i): Planned => {
      const old = match[i];
      return old
        ? { old, slug: old.name.slug, format: old.name.format, text: p.text }
        : { slug: slugOf(p.title), format: p.format ?? 'markdown', text: p.text };
    }),
    ...existing.slice(to).map(keep),
  ];
  if (planned.length > MAX_SECTIONS) {
    throw new ApiError(422, 'validation_error', `a part can have at most ${MAX_SECTIONS} sections`);
  }

  // Every old file goes, and every planned one is written; a renumbered file can land on a name another
  // had, so the writes win, and what ends up as it was is left out.
  const next = new Map<string, string | null>(existing.slice(from, to).map((file) => [file.path, null]));
  const numbers = orders(planned);
  const writes = new Map<string, string>();
  for (const [i, item] of planned.entries()) {
    let path = `${part}/${pad(numbers[i])}-${item.slug}.${extension(item.format)}`;
    for (let n = 2; writes.has(path); n += 1) {
      path = `${part}/${pad(numbers[i])}-${item.slug}-${n}.${extension(item.format)}`;
    }
    writes.set(path, item.text);
    if (item.old && item.old.path !== path) next.set(item.old.path, null);
  }
  for (const [path, text] of writes) next.set(path, text);
  const before = new Map(existing.map((file) => [file.path, file.text]));
  return [...next]
    .filter(([path, content]) => before.get(path) !== (content ?? undefined))
    .map(([path, content]) => ({ path, content }));
}
