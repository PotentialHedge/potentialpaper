/**
 * Free-text search input, before it reaches Postgres. Pure and client-safe.
 *
 * The query text itself is always sent as a bound parameter to
 * `websearch_to_tsquery`, which accepts any string (quotes, `OR`, `-word`) and
 * never raises a syntax error. The only tsquery text built here is the prefix
 * fallback below, and it is made of letters and digits only.
 */

/** `relevance` only means something with words to rank by; without them it reads as `activity`. */
/**
 * `rating`: by each paper's latest reviewed submission's headline score, as a share of the venue's scale
 * (`server/paper-ratings.ts`), so papers from venues that score differently compare.
 */
export const SEARCH_SORTS = ['relevance', 'rating', 'activity', 'newest', 'oldest', 'title'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Longest accepted query, in characters. The API refuses longer; the UI truncates. */
export const SEARCH_MAX_LENGTH = 200;

/**
 * Trimmed, whitespace-collapsed, control characters removed (Postgres refuses
 * a NUL in text), truncated to `SEARCH_MAX_LENGTH`. `null` when nothing is left,
 * which means "no search" — an empty or blank `q` is ignored, not an error.
 */
export function normalizeSearch(q: string | null | undefined): string | null {
  if (q == null) return null;
  const s = q
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SEARCH_MAX_LENGTH)
    .trim();
  return s === '' ? null : s;
}

/** Websearch syntax: a quote, a `-word` negation, or a bare `or`. */
function usesOperators(q: string): boolean {
  return /"/.test(q) || /(^|\s)-\S/.test(q) || /(^|\s)or(\s|$)/i.test(q);
}

/**
 * A `to_tsquery` string that ANDs every word and matches the **last** one as a
 * prefix — `"attention transf"` → `attention & transf:*` — so a half-typed word
 * still finds something. It is OR-ed with the websearch query, never used
 * alone.
 *
 * `null` when the query uses websearch operators: a prefix query cannot
 * express a phrase or a negation, and OR-ing it in would bring back exactly
 * the rows `-word` excluded. Explicit syntax gets exact websearch semantics.
 */
export function prefixTsquery(q: string): string | null {
  if (usesOperators(q)) return null;
  const words = q.match(/[\p{L}\p{M}\p{N}]+/gu);
  if (!words) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(' & ');
}

/**
 * The characters that mark matched words in a search hit's snippet (`server/search.ts`): private-use, so the
 * index never holds them (`server/search-index.ts` takes them out) and the snippet stays plain text.
 */
export const MARK_START = '\uE000';
export const MARK_END = '\uE001';

/** A snippet as runs of plain and matched text, for the page to render (never as HTML). */
export function snippetParts(snippet: string): { text: string; marked: boolean }[] {
  const parts: { text: string; marked: boolean }[] = [];
  for (const [i, piece] of snippet.split(/[\uE000\uE001]/).entries()) {
    if (piece !== '') parts.push({ text: piece, marked: i % 2 === 1 });
  }
  return parts;
}
