import { type FieldValue, type ScoreChange, scoreOf } from './submissions';

/**
 * Reading the OpenReview scraper's record of each review's scores (`review_scores` in its corpus, which acceptodds'
 * `scoreChanges` come from) as a note file's `scoreChanges`, for `scripts/import-score-changes.ts`.
 *
 * The corpus names a score by its label as acceptodds shows it: the content key with spaces and a capital
 * (`Soundness`, `Paper formatting concerns`), and the review's rating as `Rating`, whichever of its rating fields it has.
 */

/** One row of `review_scores`: a review's scores as a sync first saw them. */
export interface ScoreRecord {
  at: string;
  scores: Record<string, number>;
}

/** The fields the scraper reads as a review's rating, the first it has. As `push_reviews.RATING_FIELDS`. */
const RATING_FIELDS = ['rating', 'overall_rating', 'final_rating', 'score'];

/** `paper_formatting_concerns` → `Paper formatting concerns`, as Python's `str.capitalize` makes it. */
function labelOf(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/** The content key the corpus's `label` names in a note's `content`, or `null`. */
export function keyOfLabel(label: string, content: Record<string, FieldValue>): string | null {
  if (label === 'Rating') return RATING_FIELDS.find((key) => scoreOf(content[key]) !== null) ?? null;
  const rating = RATING_FIELDS.find((key) => scoreOf(content[key]) !== null);
  return Object.keys(content).find((key) => key !== rating && labelOf(key) === label) ?? null;
}

/**
 * A note's `scoreChanges` from the corpus's `history` of it (oldest first) and its content now. The corpus's first
 * record is the first score; `at` is when the score now in the file was first seen in the run of records ending the
 * history, or, when the file holds a score the corpus never ended on, what the file said (`existing`) or `now`. A score
 * the corpus doesn't know keeps the file's change.
 */
export function scoreChangesFromHistory(
  history: readonly ScoreRecord[],
  content: Record<string, FieldValue>,
  existing: readonly ScoreChange[],
  now: string,
): ScoreChange[] {
  const out = new Map(existing.map((change) => [change.field, change]));
  if (history.length === 0) return [...out.values()];
  const first = history[0].scores;
  for (const [label, from] of Object.entries(first)) {
    const field = keyOfLabel(label, content);
    if (!field) continue;
    const to = scoreOf(content[field]);
    if (to === null) continue;
    out.delete(field);
    if (to === from) continue;
    let since: string | null = null;
    for (let i = history.length - 1; i >= 0 && history[i].scores[label] === to; i--) since = history[i].at;
    const at = since ?? existing.find((change) => change.field === field)?.at ?? now;
    out.set(field, { field, from, at: new Date(at).toISOString() });
  }
  return [...out.values()].sort((a, b) => a.field.localeCompare(b.field));
}
