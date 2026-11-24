import { describe, expect, it } from 'vitest';
import {
  coreadVotes,
  DIVERSITY,
  MAX_SOURCES,
  NEAREST,
  RECENCY,
  scoreCandidates,
  sourceWeights,
  topSources,
  vectorVotes,
  WEIGHT,
  type Vote,
} from '@/lib/recommend';

const at = (n: number) => new Date(Date.UTC(2026, 0, n));

describe('sourceWeights', () => {
  it('sums kinds per paper and discounts by order, newest first', () => {
    const w = sourceWeights([
      { paperId: 'a', kind: 'follow', at: at(3) },
      { paperId: 'b', kind: 'authored', at: at(2) },
      { paperId: 'a', kind: 'comment', at: at(1) },
    ]);
    expect(w.get('a')).toBeCloseTo(WEIGHT.follow + WEIGHT.comment * RECENCY ** 2);
    expect(w.get('b')).toBeCloseTo(WEIGHT.authored * RECENCY);
  });

  it('does not depend on the input order', () => {
    const acts = [
      { paperId: 'a', kind: 'follow' as const, at: at(1) },
      { paperId: 'b', kind: 'follow' as const, at: at(1) },
      { paperId: 'c', kind: 'edit' as const, at: at(2) },
    ];
    expect(new Map(sourceWeights([...acts].reverse()))).toEqual(sourceWeights(acts));
  });
});

describe('topSources', () => {
  it('keeps the heaviest, ties by id', () => {
    const w = new Map(Array.from({ length: MAX_SOURCES + 5 }, (_, i) => [`p${String(i).padStart(2, '0')}`, 1]));
    w.set('z', 5);
    const top = topSources(w);
    expect(top).toHaveLength(MAX_SOURCES);
    expect(top[0]).toBe('z');
    expect(top[1]).toBe('p00');
  });
});

describe('votes', () => {
  it('ranks vector neighbours from 1 down', () => {
    const ids = Array.from({ length: NEAREST + 3 }, (_, i) => `n${i}`);
    const votes = vectorVotes('s', ids);
    expect(votes).toHaveLength(NEAREST);
    expect(votes[0].strength).toBe(1);
    expect(votes.at(-1)!.strength).toBeCloseTo(1 / NEAREST);
  });

  it('scales co-reading by the best count, but never above a few readers', () => {
    const votes = coreadVotes([
      { source: 's', target: 'a', count: 10 },
      { source: 's', target: 'b', count: 5 },
      { source: 't', target: 'c', count: 1 },
    ]);
    expect(votes.map((v) => v.strength)).toEqual([1, 0.5, 1 / 3]);
  });
});

describe('scoreCandidates', () => {
  const vote = (source: string, target: string, strength = 1, via: Vote['via'] = 'vector'): Vote => ({
    source,
    target,
    strength,
    via,
  });

  it('leaves out the sources and votes from papers that are not sources', () => {
    const scores = scoreCandidates(new Map([['s', 1]]), [vote('s', 's'), vote('s', 'x'), vote('other', 'y')]);
    expect([...scores.keys()]).toEqual(['x']);
  });

  it('raises a paper near several sources', () => {
    const scores = scoreCandidates(
      new Map([
        ['s', 1],
        ['t', 1],
      ]),
      [vote('s', 'both'), vote('t', 'both'), vote('s', 'one')],
    );
    expect(scores.get('both')!).toBeGreaterThan(scores.get('one')!);
  });

  it('counts one kind of vote once per source', () => {
    const once = scoreCandidates(new Map([['s', 1]]), [vote('s', 'x', 1, 'link')]);
    const twice = scoreCandidates(new Map([['s', 1]]), [vote('s', 'x', 1, 'link'), vote('s', 'x', 1, 'link')]);
    expect(twice.get('x')).toBe(once.get('x'));
  });

  it('spreads the top over sources', () => {
    const scores = scoreCandidates(
      new Map([
        ['s', 1],
        ['t', 1],
      ]),
      [vote('s', 'a', 1), vote('s', 'b', 1), vote('t', 'c', 0.9)],
    );
    // b is as near s as a, but second of s's group; c, t's first, passes it.
    expect(scores.get('b')).toBeCloseTo(1 * DIVERSITY);
    expect(scores.get('c')!).toBeGreaterThan(scores.get('b')!);
  });

  it('gives nothing to a candidate whose only source has no weight', () => {
    expect(scoreCandidates(new Map([['s', 0]]), [vote('s', 'x')]).size).toBe(0);
  });
});
