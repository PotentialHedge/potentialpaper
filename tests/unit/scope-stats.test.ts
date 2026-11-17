import { describe, expect, it } from 'vitest';
import { binRange, binsOf, fieldStats, outcomeOf, quantile } from '@/lib/scope-stats';
import { scoreFieldsOf } from '@/server/scope-stats';

/** Score statistics' pure parts (`lib/scope-stats.ts`): bins, the split by outcome, and which fields count. */

describe('score statistics', () => {
  it('bins between the form range, the last bin closed, values outside at the ends', () => {
    const bins = binsOf([0, 0.49, 0.5, 9.99, 10, 12, -1], 0, 10, 20);
    expect(bins.width).toBe(0.5);
    expect(bins.counts[0]).toBe(3); // 0, 0.49 and -1
    expect(bins.counts[1]).toBe(1);
    expect(bins.counts[19]).toBe(3); // 9.99, 10 and 12
    expect(bins.counts.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it("takes the means' own whole range without a form's", () => {
    expect(binRange([2.5, 3.67], null, null)).toEqual([2, 4]);
    expect(binRange([3, 3], null, null)).toEqual([3, 4]);
    expect(binRange([], 1, 4)).toEqual([1, 4]);
  });

  it('splits by outcome, a desk rejection as rejected and no status as pending', () => {
    expect(
      ['accepted', 'desk_rejected', 'rejected', 'withdrawn', 'under_review', null].map((s) => outcomeOf(s as never)),
    ).toEqual(['accepted', 'rejected', 'rejected', 'withdrawn', 'pending', 'pending']);
    const stats = fieldStats(
      [
        { value: 6, outcome: 'accepted' },
        { value: 3, outcome: 'rejected' },
        { value: 5.5, outcome: 'pending' },
      ],
      0,
      10,
    );
    expect(stats.values).toEqual([3, 5.5, 6]);
    expect(stats.count).toBe(3);
    expect(stats.byStatus.accepted.values).toEqual([6]);
    expect(stats.byStatus.withdrawn).toMatchObject({ count: 0, values: [] });
    // Every group's bins share the field's range, so they stack.
    expect(stats.byStatus.rejected.bins).toMatchObject({ lo: 0, hi: 10 });
  });

  it('reads off a standing', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("counts the fields a venue's review forms mark score, summary first", () => {
    const forms = {
      Official_Review: {
        label: 'Review',
        fields: [
          { key: 'summary', label: 'Summary', type: 'text' as const },
          { key: 'soundness', label: 'Soundness', type: 'score' as const, min: 1, max: 4 },
          { key: 'rating', label: 'Rating', type: 'score' as const, min: 0, max: 10 },
          { key: 'guess', label: 'Guess' },
        ],
        summary: ['rating'],
      },
      Meta_Review: { label: 'Meta', fields: [{ key: 'recommendation', label: 'Rec', type: 'score' as const }] },
    };
    expect(scoreFieldsOf(forms, ['Official_Review']).map((f) => [f.key, f.min, f.max])).toEqual([
      ['rating', 0, 10],
      ['soundness', 1, 4],
    ]);
    expect(scoreFieldsOf(forms, ['Unknown'])).toEqual([]);
  });
});
