import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';

/**
 * Whether a paper is under anonymous review: a submission of it, or of a duplicate merged into it, is still under
 * review at a venue. Its authors may be known from another version (an arXiv preprint), but while it is, nothing
 * shows who claimed it: claimed names don't link to accounts, it isn't on their pages, and only an author whose
 * address is printed on it can claim it, without the names being shown (`app/claim/`).
 */
export const UNDER_REVIEW = (paperId: SQL | string) => sql`exists (
  select 1 from submissions s join papers sp on sp.id = s.paper_id
   where (sp.id = ${paperId} or sp.merged_into = ${paperId}) and s.status = 'under_review')`;

export interface ReviewVenue {
  id: string;
  /** "ICLR 2027". */
  name: string;
}

/** The venues a paper, or a duplicate merged into it, is still under review at: none when it isn't (`ReviewBlur`). */
export async function reviewVenues(paperId: string, database: Database = getDb()): Promise<ReviewVenue[]> {
  const { rows } = await database.execute<{ id: string; name: string }>(sql`
    select distinct v.id, v.name from submissions s
      join papers sp on sp.id = s.paper_id
      join venues v on v.id = s.venue_id
     where (sp.id = ${paperId} or sp.merged_into = ${paperId}) and s.status = 'under_review'
     order by v.name`);
  return rows.map(({ id, name }) => ({ id, name }));
}

export async function underReview(paperId: string, database: Database = getDb()): Promise<boolean> {
  const { rows } = await database.execute<{ under: boolean }>(sql`select ${UNDER_REVIEW(paperId)} as under`);
  return rows[0]?.under ?? false;
}
