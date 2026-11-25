import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { rebuildPaperRatings, refreshPaperRating, refreshVenueRatings } from '@/server/paper-ratings';
import { searchPapers } from '@/server/search';
import { closePool, resetDatabase } from './helpers';

/**
 * The home list's rating sort (`server/paper-ratings.ts`): a paper's latest reviewed submission's mean headline score,
 * as a share of its venue's scale, so papers from venues that score differently compare.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const form = (min?: number, max?: number) => ({
  Official_Review: {
    label: 'Official review',
    summary: ['rating'],
    fields: [
      { key: 'confidence', type: 'score', label: 'Confidence', min: 1, max: 5 },
      { key: 'rating', type: 'score', label: 'Rating', ...(min === undefined ? {} : { min, max }) },
    ],
  },
});

async function venue(id: string, forms: unknown) {
  await getDb().execute(
    sql`insert into venues (id, name, forms) values (${id}, ${id}, ${JSON.stringify(forms)}::jsonb)`,
  );
}

let n = 0;
async function paper(title: string): Promise<string> {
  const { rows } = await getDb().execute<{ id: string }>(
    sql`insert into papers (title, source) values (${title}, 'openreview') returning id`,
  );
  await getDb().execute(
    sql`insert into paper_identifiers (scheme, value, paper_id) values ('openreview', ${`p${++n}`}, ${rows[0].id})`,
  );
  return rows[0].id;
}

/** A submission of `paperId` to `venueId` with reviews giving `ratings`, written on `day`. */
async function reviewed(paperId: string, venueId: string, ratings: (number | string)[], day = 1) {
  const { rows } = await getDb().execute<{ id: string }>(sql`
    insert into submissions (paper_id, venue_id, external_id, fetched_at)
    values (${paperId}, ${venueId}, ${`s${++n}`}, now()) returning id`);
  for (const [i, rating] of ratings.entries()) {
    await getDb().execute(sql`
      insert into submission_notes (submission_id, external_id, kind, invitation, signature, content, license, created_at)
      values (${rows[0].id}, ${`n${++n}`}, 'review', 'Official_Review', ${`Reviewer ${i}`},
              ${JSON.stringify({ rating, confidence: 5 })}::jsonb, 'CC BY 4.0', ${new Date(Date.UTC(2026, 0, day))})`);
  }
}

const byRating = async () => (await searchPapers({ sort: 'rating' })).hits.map((h) => h.title);

describe('paper ratings', () => {
  it('compares papers across scales by their share of the range, unrated papers last', async () => {
    await venue('openreview:Four', form(1, 4));
    await venue('openreview:Ten', form(1, 10));
    const a = await paper('A: 3 of 1–4'); // 2/3
    const b = await paper('B: 8 of 1–10'); // 7/9, above A
    const c = await paper('C: 4 of 1–10'); // 1/3, below A
    await paper('D: unrated');
    await reviewed(a, 'openreview:Four', [3, '3: weak accept']);
    await reviewed(b, 'openreview:Ten', [8, 8]);
    await reviewed(c, 'openreview:Ten', [4]);
    expect(await rebuildPaperRatings()).toBe(3);
    expect(await byRating()).toEqual(['B: 8 of 1–10', 'A: 3 of 1–4', 'C: 4 of 1–10', 'D: unrated']);
    // Each hit carries its mean, which the home list shows beside the venue.
    const hits = (await searchPapers({ sort: 'rating' })).hits.map((h) => [h.title, h.rating]);
    expect(hits).toEqual([
      ['B: 8 of 1–10', 8],
      ['A: 3 of 1–4', 3],
      ['C: 4 of 1–10', 4],
      ['D: unrated', null],
    ]);
  });

  it('rates a paper by its latest reviewed submission', async () => {
    await venue('openreview:Ten', form(1, 10));
    const a = await paper('A');
    const b = await paper('B');
    await reviewed(a, 'openreview:Ten', [10], 1);
    await reviewed(a, 'openreview:Ten', [2], 5);
    await reviewed(b, 'openreview:Ten', [5], 1);
    await refreshPaperRating(getDb(), a);
    await refreshPaperRating(getDb(), b);
    expect(await byRating()).toEqual(['B', 'A']);
  });

  it('takes the range from the venue’s scores when its form gives none, and again when the form changes', async () => {
    await venue('openreview:Bare', form());
    const [lo, mid, hi] = [await paper('lo'), await paper('mid'), await paper('hi')];
    await reviewed(lo, 'openreview:Bare', [1]);
    await reviewed(mid, 'openreview:Bare', [2]);
    await reviewed(hi, 'openreview:Bare', [3]);
    await rebuildPaperRatings();
    const { rows } = await getDb().execute<{ min: number | null }>(sql`select min from paper_ratings`);
    expect(rows.every((r) => r.min === null)).toBe(true);
    expect(await byRating()).toEqual(['hi', 'mid', 'lo']);

    await getDb().execute(sql`update venues set forms = ${JSON.stringify(form(1, 10))}::jsonb`);
    await refreshVenueRatings(getDb(), ['openreview:Bare']);
    const after = await getDb().execute<{ min: number; max: number }>(sql`select distinct min, max from paper_ratings`);
    expect(after.rows).toEqual([{ min: 1, max: 10 }]);
  });
});
