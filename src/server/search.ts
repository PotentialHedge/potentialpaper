import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_QUERY_MAX = 200;

export interface SearchHit {
  scheme: 'arxiv' | 'doi' | 'openreview';
  value: string;
  title: string;
  authors: string[];
  abstract: string | null;
  year: number | null;
  venue: string | null;
}

/**
 * Papers matching `query`, best first: full text over titles and abstracts, plus title similarity so
 * that a misspelled title still finds its paper. Each hit carries one identifier, the one its address uses.
 */
export async function searchPapers(
  query: string,
  page = 1,
  database: Database = getDb(),
): Promise<{ hits: SearchHit[]; hasMore: boolean }> {
  const q = query.trim().slice(0, SEARCH_QUERY_MAX);
  if (q.length < 2) return { hits: [], hasMore: false };
  const { rows } = await database.execute<SearchHit & Record<string, unknown>>(sql`
    with query as (select websearch_to_tsquery('english', ${q}) as ts)
    select i.scheme, i.value, p.title, p.authors, left(p.abstract, 400) as abstract, p.year, p.venue
    from papers p
    cross join query
    cross join lateral (
      select scheme, value from paper_identifiers
      where paper_id = p.id
      order by array_position(array['arxiv', 'doi', 'openreview'], scheme)
      limit 1
    ) i
    where p.merged_into is null and (p.search @@ query.ts or p.title % ${q})
    order by ts_rank_cd(p.search, query.ts) + similarity(p.title, ${q}) desc, p.id
    limit ${SEARCH_PAGE_SIZE + 1} offset ${(page - 1) * SEARCH_PAGE_SIZE}
  `);
  return { hits: rows.slice(0, SEARCH_PAGE_SIZE), hasMore: rows.length > SEARCH_PAGE_SIZE };
}
