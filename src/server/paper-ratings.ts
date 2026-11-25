import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import type { VenueForms } from '@/lib/submissions';
import type { Writer } from './pages/projections';
import { scoreFieldsOf, type ScoreField } from './scope-stats';

/**
 * `paper_ratings`, the home list's `rating` sort: per paper, its latest reviewed submission (the one whose newest
 * review is newest) and that submission's mean of the venue's headline score. The sort reads it as a share of the
 * score's range, `(mean - min) / (max - min)` (`ratingSql`), so ICLR's 1–4 and NeurIPS' 1–6 both run from 0 to 1.
 * The range is the form's; where the form doesn't say, the lowest and highest mean among the venue's rated papers.
 *
 * Written with a paper's reviews (`review-projection.ts`) and again for a venue's papers when its forms change
 * (`pages/venue-projection.ts`); `npm run ratings:rebuild` writes every paper's.
 */

/** A score as a field's value gives it: `6`, or `"6: marginally above"`. As `scope-stats.ts` reads one. */
const SCORE_RE = '^\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?::|$)';

/** The field a venue's papers are rated by: the first score field of its review forms, its summary's first. */
export function headlineField(forms: VenueForms, invitations: readonly string[]): ScoreField | null {
  return scoreFieldsOf(forms, invitations)[0] ?? null;
}

/** Writes the ratings of the papers `papers` (a subquery of paper ids) from their submissions and reviews. */
export async function refreshPaperRatings(db: Writer, papers: SQL): Promise<void> {
  const { rows: venueRows } = await db.execute<{ venue_id: string; forms: VenueForms; invitations: string[] }>(sql`
    with subs as (select s.id, s.venue_id from submissions s where s.paper_id in (${papers}))
    select v.id as venue_id, v.forms,
           array(select distinct n.invitation from subs s2
                   join submission_notes n on n.submission_id = s2.id and n.kind = 'review'
                  where s2.venue_id = v.id) as invitations
      from venues v
     where v.id in (select venue_id from subs)
  `);
  const fields = venueRows.flatMap((row) => {
    const field = headlineField(row.forms ?? {}, row.invitations);
    if (!field) return [];
    // A range only when the form gives a sensible one; otherwise the sort finds one.
    const ranged = field.min !== null && field.max !== null && field.max > field.min;
    return [{ venue: row.venue_id, key: field.key, min: ranged ? field.min : null, max: ranged ? field.max : null }];
  });

  await db.execute(sql`delete from paper_ratings where paper_id in (${papers})`);
  if (fields.length === 0) return;
  await db.execute(sql`
    with fields as (
      select * from jsonb_to_recordset(${JSON.stringify(fields)}::jsonb) as f(venue text, key text, min float8, max float8)
    ),
    scores as (
      select s.id, s.paper_id, s.venue_id, f.key, f.min, f.max, n.created_at,
             case when jsonb_typeof(n.content -> f.key) = 'number' then (n.content ->> f.key)::float8
                  else (regexp_match(n.content ->> f.key, ${SCORE_RE}))[1]::float8 end as score,
             (select (c ->> 'from')::float8 from jsonb_array_elements(n.score_changes) c
               where c ->> 'field' = f.key limit 1) as first
        from submissions s
        join fields f on f.venue = s.venue_id
        join submission_notes n on n.submission_id = s.id and n.kind = 'review'
       where s.paper_id in (${papers})
    ),
    per_submission as (
      select id, paper_id, venue_id, key, min, max, avg(score) as mean, avg(coalesce(first, score)) as first_mean,
             count(*)::int as reviews,
             max(created_at) as latest
        from scores
       where score is not null
       group by id, paper_id, venue_id, key, min, max
    )
    insert into paper_ratings (paper_id, venue_id, field, mean, first_mean, reviews, min, max)
    select distinct on (paper_id) paper_id, venue_id, key, mean, first_mean, reviews, min, max
      from per_submission
     order by paper_id, latest desc, id
  `);
}

/** One paper's rating, after its reviews changed. */
export function refreshPaperRating(db: Writer, paperId: string): Promise<void> {
  return refreshPaperRatings(db, sql`select ${paperId}::uuid`);
}

/** The ratings of every paper with a submission to `venueIds`, after their forms changed. */
export function refreshVenueRatings(db: Writer, venueIds: readonly string[]): Promise<void> {
  if (venueIds.length === 0) return Promise.resolve();
  return refreshPaperRatings(
    db,
    sql`select distinct paper_id from submissions where venue_id = any(${sql.param([...venueIds])}::text[])`,
  );
}

/** Papers rated per statement by `rebuildPaperRatings`, so none runs into the statement timeout. */
const REBUILD_CHUNK = 2000;

/** Every paper's rating, from scratch, a chunk of papers at a time. */
export async function rebuildPaperRatings(database: Database = getDb()): Promise<number> {
  await database.execute(sql`truncate paper_ratings`);
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await database.execute<{ last: string | null }>(sql`
      select paper_id::text as last from (
        select distinct paper_id from submissions where paper_id > ${after}::uuid order by paper_id limit ${REBUILD_CHUNK}
      ) x order by paper_id desc limit 1
    `);
    const last = rows[0]?.last;
    if (!last) break;
    await refreshPaperRatings(
      database,
      sql`select distinct paper_id from submissions where paper_id > ${after}::uuid and paper_id <= ${last}::uuid`,
    );
    after = last;
  }
  const { rows } = await database.execute<{ n: number }>(sql`select count(*)::int as n from paper_ratings`);
  return rows[0].n;
}

/**
 * A paper's rating in [0, 1], on `pr` (its `paper_ratings` row) and `vr` (`ratingRanges`): null when it has none, or
 * its venue's scores don't spread.
 */
export const ratingSql = sql`least(1, greatest(0,
  (pr.mean - coalesce(pr.min, vr.lo)) / nullif(coalesce(pr.max, vr.hi) - coalesce(pr.min, vr.lo), 0)))`;

/** `paper_ratings pr` and each venue's spread of means `vr`, to left join on `p.id`, for `ratingSql`. */
export const ratingJoins = sql`left join paper_ratings pr on pr.paper_id = p.id
  left join (select venue_id, min(mean) as lo, max(mean) as hi from paper_ratings group by venue_id) vr
    on vr.venue_id = pr.venue_id`;
