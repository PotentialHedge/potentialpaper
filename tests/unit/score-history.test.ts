import { describe, expect, it } from 'vitest';
import { keyOfLabel, scoreChangesFromHistory } from '@/lib/score-history';

const NOW = '2026-11-25T09:00:00.000Z';
const CONTENT = { rating: 3, soundness: 2, confidence: 3, paper_formatting_concerns: 'None.', summary: 'Fine.' };
const HISTORY = [
  { at: '2026-11-12T20:55:00Z', scores: { Rating: 2, Soundness: 2, Confidence: 3 } },
  { at: '2026-11-16T10:51:17Z', scores: { Rating: 2, Soundness: 2, Confidence: 3 } },
  { at: '2026-11-18T07:50:59Z', scores: { Rating: 3, Soundness: 2, Confidence: 3 } },
  { at: '2026-11-19T07:50:59Z', scores: { Rating: 3, Soundness: 2, Confidence: 3 } },
];

describe('keyOfLabel', () => {
  it('finds the rating field and a labelled score', () => {
    expect(keyOfLabel('Rating', CONTENT)).toBe('rating');
    expect(keyOfLabel('Rating', { overall_rating: '6: accept' })).toBe('overall_rating');
    expect(keyOfLabel('Soundness', CONTENT)).toBe('soundness');
    expect(keyOfLabel('Paper formatting concerns', CONTENT)).toBe('paper_formatting_concerns');
    expect(keyOfLabel('Novelty', CONTENT)).toBeNull();
  });
});

describe('scoreChangesFromHistory', () => {
  it('keeps the first score, and when the current one was first seen', () => {
    expect(scoreChangesFromHistory(HISTORY, CONTENT, [], NOW)).toEqual([
      { field: 'rating', from: 2, at: '2026-11-18T07:50:59.000Z' },
    ]);
  });

  it("puts the corpus's earlier first score over one the import recorded later, and drops one that didn't move", () => {
    const existing = [
      { field: 'rating', from: 2.5, at: '2026-11-24T00:00:00.000Z' },
      { field: 'confidence', from: 4, at: '2026-11-24T00:00:00.000Z' },
      { field: 'novelty', from: 1, at: '2026-11-24T00:00:00.000Z' },
    ];
    expect(scoreChangesFromHistory(HISTORY, CONTENT, existing, NOW)).toEqual([
      { field: 'novelty', from: 1, at: '2026-11-24T00:00:00.000Z' },
      { field: 'rating', from: 2, at: '2026-11-18T07:50:59.000Z' },
    ]);
  });

  it('dates a score the corpus never ended on by the file, else now', () => {
    const content = { ...CONTENT, rating: 4 };
    expect(scoreChangesFromHistory(HISTORY, content, [], NOW)).toEqual([{ field: 'rating', from: 2, at: NOW }]);
    const existing = [{ field: 'rating', from: 3, at: '2026-11-24T00:00:00.000Z' }];
    expect(scoreChangesFromHistory(HISTORY, content, existing, NOW)).toEqual([
      { field: 'rating', from: 2, at: '2026-11-24T00:00:00.000Z' },
    ]);
  });

  it('has none for a review back where it started', () => {
    expect(scoreChangesFromHistory(HISTORY, { ...CONTENT, rating: 2 }, [], NOW)).toEqual([]);
  });
});
