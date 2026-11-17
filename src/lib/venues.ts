import { SLUG } from './kinds';

/**
 * Venue pages from the venues a source already knows (`handoffs/pages.md` Phase 2). A source names a venue by its
 * own id (`openreview:ICLR.cc/2027/Conference`, the `venues` table's key); the site names it by a page key, a series
 * (`iclr`) and its editions under it (`iclr/2027`). This says which pages a source's venue is, and what they are
 * called. Pure, shared by the `venues` bot (`server/venue-pages.ts`) and the tests.
 *
 * Only a conference's main edition maps for now: `<Group>[.tld]/…/<Series>/<year>/Conference`. Its tracks and
 * workshops (`NeurIPS.cc/2025/Datasets_and_Benchmarks_Track`, `ICLR.cc/2025/Workshop/…`) and undated venues
 * (`TMLR`) wait for venue children with their own sources ("Later" in the plan), so they make no page yet.
 */

export interface VenuePlace {
  /** The series' key and name: `iclr`, "ICLR". */
  series: { key: string; name: string };
  /** The edition's key, name and year: `iclr/2027`, "ICLR 2027", 2027. */
  edition: { key: string; name: string; year: number };
  /** The source's id, as the edition's `venue.json` lists it: `openreview:ICLR.cc/2027/Conference`. */
  source: string;
}

/** `ICLR.cc` → "ICLR", `robot-learning.org/CoRL` → "CoRL": the last segment before the year, without its domain. */
function seriesName(segment: string): string {
  const dot = segment.indexOf('.');
  return dot > 0 ? segment.slice(0, dot) : segment;
}

/** "ICLR" → `iclr`, "MIDL" → `midl`, "Learning on Graphs" → `learning-on-graphs`; `null` if nothing is left. */
export function seriesSlug(name: string): string | null {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug && SLUG.test(slug) ? slug : null;
}

/**
 * The series and edition a source's venue is, or `null` when it isn't a conference's main edition. `name` is how the
 * source names the venue ("ICLR 2027"), which the edition keeps; the series is named from the id.
 */
export function venuePlace(source: string, name?: string | null): VenuePlace | null {
  const colon = source.indexOf(':');
  if (colon <= 0) return null;
  const scheme = source.slice(0, colon);
  const id = source.slice(colon + 1);
  if (scheme !== 'openreview') return null;
  const segments = id.split('/');
  const at = segments.findIndex((segment) => /^(19|20)\d{2}$/.test(segment));
  if (at < 1 || at !== segments.length - 2 || segments[at + 1] !== 'Conference') return null;
  const series = seriesName(segments[at - 1]);
  const key = seriesSlug(series);
  if (!key) return null;
  const year = Number(segments[at]);
  return {
    series: { key, name: series },
    edition: { key: `${key}/${year}`, name: name?.trim() || `${series} ${year}`, year },
    source,
  };
}

/** The source's own page for a venue, when it has one: OpenReview's group page. */
export function sourceUrl(source: string): string | null {
  if (!source.startsWith('openreview:')) return null;
  return `https://openreview.net/group?id=${encodeURIComponent(source.slice('openreview:'.length))}`;
}

/** How a source is named in a sentence: "OpenReview". */
export function sourceTitle(source: string): string {
  const scheme = source.slice(0, Math.max(0, source.indexOf(':')));
  return scheme === 'openreview' ? 'OpenReview' : scheme || source;
}
