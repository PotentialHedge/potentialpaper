import type { SubmissionStatus } from './submissions';

/**
 * Score statistics of a scope (`handoffs/plugins.md` Phase 4, data for plugins A): for each venue its papers were
 * submitted to and each score field of that venue's review forms, every submission's mean over its reviews, sorted,
 * with fixed-width bins and the same split by outcome. Pure, so the consumer (`server/scope-stats.ts`), the routes, the
 * venue page and the tests share it.
 *
 * The venue stays in the key even on a category's or an organisation's page, since a 6 at ICLR and a 6 at NeurIPS are
 * different scales.
 */

/** Outcomes the statistics are split by. `pending` is under review or not said; a desk rejection counts as rejected. */
export const STAT_OUTCOMES = ['accepted', 'rejected', 'withdrawn', 'pending'] as const;
export type StatOutcome = (typeof STAT_OUTCOMES)[number];

export function outcomeOf(status: SubmissionStatus | null): StatOutcome {
  if (status === 'accepted') return 'accepted';
  if (status === 'rejected' || status === 'desk_rejected') return 'rejected';
  if (status === 'withdrawn') return 'withdrawn';
  return 'pending';
}

/** How many bins a field is cut into, between its form's `min` and `max` (or the means' own, without them). */
export const BIN_COUNT = 20;

/** Fixed-width bins: `counts[i]` holds the means in `[lo + i·width, lo + (i+1)·width)`, the last closed at `hi`. */
export interface Bins {
  lo: number;
  hi: number;
  width: number;
  counts: number[];
}

/** The numbers of one group of submissions. */
export interface ScoreGroup {
  count: number;
  /** Each submission's mean over its reviews, ascending. */
  values: number[];
  bins: Bins;
}

export interface FieldStats extends ScoreGroup {
  /** The range the venue's form states, if it does. */
  min: number | null;
  max: number | null;
  /** The same, split by outcome; every outcome is there, empty ones with a count of 0. */
  byStatus: Record<StatOutcome, ScoreGroup>;
}

/** Where the bins go: the form's range, or the means' own whole-number range without one. */
export function binRange(values: readonly number[], min: number | null, max: number | null): [number, number] {
  let lo = min ?? (values.length ? Math.floor(values[0]) : 0);
  let hi = max ?? (values.length ? Math.ceil(values[values.length - 1]) : 1);
  if (!(hi > lo)) hi = lo + 1;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  return [lo, hi];
}

/** Bins of ascending `values` over `[lo, hi]`; a value outside the range goes to the nearest end. */
export function binsOf(values: readonly number[], lo: number, hi: number, count = BIN_COUNT): Bins {
  const width = (hi - lo) / count;
  const counts = Array.from({ length: count }, () => 0);
  for (const value of values) {
    const at = Math.floor((value - lo) / width);
    counts[Math.max(0, Math.min(count - 1, at))] += 1;
  }
  return { lo, hi, width, counts };
}

/** A field's statistics from each submission's mean and outcome. */
export function fieldStats(
  means: readonly { value: number; outcome: StatOutcome }[],
  min: number | null,
  max: number | null,
): FieldStats {
  const sorted = [...means].sort((a, b) => a.value - b.value);
  const values = sorted.map((m) => m.value);
  const [lo, hi] = binRange(values, min, max);
  const group = (vs: number[]): ScoreGroup => ({ count: vs.length, values: vs, bins: binsOf(vs, lo, hi) });
  const byStatus = Object.fromEntries(
    STAT_OUTCOMES.map((outcome) => [outcome, group(sorted.filter((m) => m.outcome === outcome).map((m) => m.value))]),
  ) as Record<StatOutcome, ScoreGroup>;
  return { ...group(values), min, max, byStatus };
}

/** The value at quantile `q` (0–1) of ascending `values`, interpolated; `null` when empty. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const at = (values.length - 1) * Math.min(1, Math.max(0, q));
  const below = Math.floor(at);
  const above = Math.min(values.length - 1, below + 1);
  return values[below] + (values[above] - values[below]) * (at - below);
}

/**
 * The site setting `plugins.venueStats.hideUntil`: `never` (the default) serves a venue's statistics as soon as there
 * are reviews; `decisions` withholds them until the venue has decided on any submission, so no page states a paper's
 * rank while its reviews are still open.
 */
export const HIDE_UNTIL = ['never', 'decisions'] as const;
export type HideUntil = (typeof HIDE_UNTIL)[number];
