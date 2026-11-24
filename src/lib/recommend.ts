/**
 * The home page's `recommended` sort's scoring, after acceptodds' (`server/recommendations.ts` gathers its inputs).
 * Pure, so it is tested without a database.
 *
 * A viewer's **sources** are the papers they deliberately acted on, each weighted by what they did (`WEIGHT`, summed
 * over kinds) and by how far back in their own history it was: the latest act counts fully, each one before it
 * `RECENCY` times as much. By order, not by date, so a reader back after a month away has as sharp a profile as one
 * active today. Each source votes for papers near it, three ways:
 *
 * - its `NEAREST` nearest papers by the site's chosen vector signals (`recommendations.vectors`), by rank: `VECTOR`;
 * - the papers its readers went on to read, or came from (`page_transitions`), by count: `COREAD`;
 * - papers it links to, or that link to it (`page_links`): `LINK`.
 *
 * A candidate's score is the sum over sources of the source's weight times its votes, so a paper near several of
 * the viewer's papers rises. Then a light diversity pass: candidates are grouped by the source that gave them the
 * most, and the k-th best of a group is multiplied by `DIVERSITY^k`, so one paper's neighbours cannot fill the top of
 * the list. Sources themselves get no score.
 */

export type InteractionKind = 'authored' | 'follow' | 'comment' | 'edit';

/** Your own paper says most about what you work on. */
export const WEIGHT: Readonly<Record<InteractionKind, number>> = {
  authored: 3,
  follow: 2,
  comment: 2,
  edit: 2,
};
/** Each step back in the viewer's acts, newest first. */
export const RECENCY = 0.9;
/** The sources that vote, heaviest first; the rest are only left out of the scores. */
export const MAX_SOURCES = 30;
/** Nearest papers by vector per source and signal. */
export const NEAREST = 20;
/** A source's co-reading counts are scaled by its best one, or by this when that is smaller: one reader is a hint. */
export const COREAD_FLOOR = 3;

export const VECTOR = 1;
export const COREAD = 0.8;
export const LINK = 0.6;
export const DIVERSITY = 0.85;

export interface Interaction {
  paperId: string;
  kind: InteractionKind;
  at: Date;
}

/**
 * Each acted-on paper's weight: kinds summed, the k-th newest act times `RECENCY^k`. Simultaneous ones are ordered
 * by paper and kind, so the result never depends on the input's order.
 */
export function sourceWeights(interactions: readonly Interaction[]): Map<string, number> {
  const newestFirst = [...interactions].sort(
    (a, b) =>
      b.at.getTime() - a.at.getTime() ||
      (a.paperId < b.paperId ? -1 : a.paperId > b.paperId ? 1 : 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
  const out = new Map<string, number>();
  newestFirst.forEach((i, k) => out.set(i.paperId, (out.get(i.paperId) ?? 0) + WEIGHT[i.kind] * RECENCY ** k));
  return out;
}

/** The heaviest `MAX_SOURCES` sources, ties by id so the choice is stable. */
export function topSources(weights: ReadonlyMap<string, number>): string[] {
  return [...weights]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_SOURCES)
    .map(([id]) => id);
}

export type Via = 'vector' | 'coread' | 'link';

/** One source's vote for one candidate, before the source's weight. */
export interface Vote {
  source: string;
  target: string;
  /** In [0, 1]. */
  strength: number;
  via: Via;
}

const VIA_WEIGHT: Readonly<Record<Via, number>> = { vector: VECTOR, coread: COREAD, link: LINK };

/** Vector votes from a source's neighbours, nearest first: 1 for the nearest, down to 1/NEAREST. */
export function vectorVotes(source: string, nearestFirst: readonly string[]): Vote[] {
  return nearestFirst.slice(0, NEAREST).map((target, k) => ({
    source,
    target,
    strength: 1 - k / NEAREST,
    via: 'vector',
  }));
}

/** Co-reading votes: each count over the source's best, or over `COREAD_FLOOR` when its best is smaller. */
export function coreadVotes(rows: readonly { source: string; target: string; count: number }[]): Vote[] {
  const best = new Map<string, number>();
  for (const r of rows) best.set(r.source, Math.max(best.get(r.source) ?? 0, r.count));
  return rows.map((r) => ({
    source: r.source,
    target: r.target,
    strength: Math.max(0, r.count) / Math.max(COREAD_FLOOR, best.get(r.source) ?? 0),
    via: 'coread',
  }));
}

/**
 * Each candidate's final score. Votes for a source, or from a paper that is not a source, are ignored. Two votes of
 * one kind from one source for one candidate (a link both ways, a neighbour on two signals) count as the stronger.
 */
export function scoreCandidates(weights: ReadonlyMap<string, number>, votes: readonly Vote[]): Map<string, number> {
  // candidate -> source -> via -> strongest vote
  const strongest = new Map<string, Map<string, Map<Via, number>>>();
  for (const v of votes) {
    if (!weights.has(v.source) || weights.has(v.target) || v.target === v.source || !(v.strength > 0)) continue;
    const perSource = strongest.get(v.target) ?? new Map<string, Map<Via, number>>();
    const perVia = perSource.get(v.source) ?? new Map<Via, number>();
    perVia.set(v.via, Math.max(perVia.get(v.via) ?? 0, Math.min(1, v.strength)));
    perSource.set(v.source, perVia);
    strongest.set(v.target, perSource);
  }

  // Raw score, and the source that gave the most (ties by id).
  const raw: { target: string; score: number; top: string }[] = [];
  for (const [target, perSource] of strongest) {
    let score = 0;
    let top = '';
    let topValue = -1;
    for (const [source, perVia] of perSource) {
      let value = 0;
      for (const [via, strength] of perVia) value += weights.get(source)! * VIA_WEIGHT[via] * strength;
      score += value;
      if (value > topValue || (value === topValue && source < top)) [top, topValue] = [source, value];
    }
    if (score > 0) raw.push({ target, score, top });
  }

  raw.sort((a, b) => b.score - a.score || (a.target < b.target ? -1 : 1));
  const rankInGroup = new Map<string, number>();
  const out = new Map<string, number>();
  for (const r of raw) {
    const k = rankInGroup.get(r.top) ?? 0;
    rankInGroup.set(r.top, k + 1);
    out.set(r.target, r.score * DIVERSITY ** k);
  }
  return out;
}
