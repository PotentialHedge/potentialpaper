import {
  MAX_AUTHOR_NAME,
  MAX_AUTHORS,
  MAX_PAPER_ABSTRACT,
  MAX_PAPER_TITLE,
  type PaperFile,
  paperFileSchema,
} from './kinds';
import { sortVersions, type PaperVersion } from './versions';

/**
 * A paper's `paper.json` (`lib/kinds.ts`) as text, and what its row says that the file doesn't: where the paper went,
 * read off its versions. Pure.
 */

/** The fields of a paper's row that `paper.json` holds. */
export interface PaperFileFields {
  title: string;
  authors: string[];
  abstract: string | null;
  metadataLicense: string | null;
  abstractLicense: string | null;
}

/** The file for a paper's row, as its source filled it in, cut to what a `paper.json` holds. */
export function paperFileOf(row: PaperFileFields): PaperFile {
  const abstract = row.abstract?.trim().slice(0, MAX_PAPER_ABSTRACT).trim();
  return {
    title: row.title.trim().slice(0, MAX_PAPER_TITLE).trim(),
    authors: row.authors
      .map((name) => name.trim().slice(0, MAX_AUTHOR_NAME).trim())
      .filter(Boolean)
      .slice(0, MAX_AUTHORS),
    ...(abstract ? { abstract } : {}),
    ...(row.metadataLicense
      ? {
          license: { metadata: row.metadataLicense, ...(row.abstractLicense ? { abstract: row.abstractLicense } : {}) },
        }
      : {}),
  };
}

/** The row's fields for a file: what `papers` projects from it. */
export function paperRowOf(file: PaperFile): PaperFileFields {
  return {
    title: file.title,
    authors: file.authors,
    abstract: file.abstract ?? null,
    metadataLicense: file.license?.metadata ?? null,
    abstractLicense: file.license?.abstract ?? null,
  };
}

/** Stable, so an unchanged paper hashes the same. */
export function encodePaperFile(file: PaperFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The file in a repo's text, or `null` if it doesn't parse. */
export function parsePaperFile(text: string | null | undefined): PaperFile | null {
  try {
    const parsed = paperFileSchema.safeParse(JSON.parse(text ?? ''));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Where a paper is listed as from, as lists, search and its header name it: the newest venue it was accepted at, or
 * else the newest it was sent to, with the year of its first version (or, with none dated, the year in that venue's
 * name: "ICLR 2027"). Read off the versions, the one place each is kept, so it can't say "under review" after the
 * venue decided.
 */
export function listedVenue(versions: readonly Pick<PaperVersion, 'date' | 'submissions'>[]): {
  venue: string | null;
  year: number | null;
} {
  const sorted = sortVersions(versions);
  const sent = sorted.flatMap((v) => v.submissions ?? []).reverse();
  const venue = (sent.find((s) => s.status === 'accepted') ?? sent[0])?.venue ?? null;
  const first = sorted.find((v) => v.date)?.date ?? /\b(19|20)\d{2}\b/.exec(venue ?? '')?.[0];
  return { venue, year: first ? Number(first.slice(0, 4)) : null };
}

/** Where a paper is listed as from, in a line: "NeurIPS 2026", or "Nature, 2021" when the venue names no year. */
export function venueLine(venue: string | null, year: number | null): string {
  if (venue && (year === null || /\b(19|20)\d{2}\b/.test(venue))) return venue;
  return [venue, year].filter(Boolean).join(', ');
}
