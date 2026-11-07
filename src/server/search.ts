import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { containsPattern, parseSearch, prefixOf, requiredText, websearchOf, type SearchNode } from '@/lib/query';
import { normalizeSearch, prefixTsquery, type SearchSort } from '@/lib/search';

export const SEARCH_PAGE_SIZE = 50;

export interface SearchHit {
  scheme: 'arxiv' | 'doi' | 'openreview';
  value: string;
  title: string;
  authors: string[];
  abstract: string | null;
  year: number | null;
  venue: string | null;
  /** The copy this site hosts, from the page's `pdf.json`. */
  pdf: string | null;
  /**
   * The paper's picture: the thumbnail its authors chose, or else the hosted PDF's first page
   * (`pdf_covers`), once one has been rendered.
   */
  cover: string | null;
}

export interface SearchFilter {
  /** The search syntax (`lib/query.ts`). Without one, every paper is listed. */
  q?: string | null;
  /** One venue, exactly. */
  venue?: string | null;
  sort?: SearchSort;
  /** From 1. */
  page?: number;
  limit?: number;
}

/** The query is a bound parameter; the prefix alternative is made of letters and digits only (`lib/search.ts`). */
function tsquery(q: string): SQL {
  const prefix = prefixTsquery(q);
  return prefix
    ? sql`(websearch_to_tsquery('english', ${q}) || to_tsquery('english', ${prefix}))`
    : sql`websearch_to_tsquery('english', ${q})`;
}

const COMPARE_SQL = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' } as const;

/**
 * A parsed search as a predicate on `papers p`. Every value is bound; operators come from the fixed map
 * above. `fuzzy`: plain words may also be a misspelled title.
 */
function predicate(node: SearchNode, fuzzy: boolean): SQL {
  switch (node.kind) {
    case 'and':
    case 'or': {
      if (node.kind === 'or' && !fuzzy) return anyOf(node.items);
      const parts = node.items.map((item) => predicate(item, fuzzy));
      return sql`(${sql.join(parts, node.kind === 'and' ? sql` and ` : sql` or `)})`;
    }
    case 'not':
      return sql`not ${predicate(node.item, fuzzy)}`;
    case 'text':
      return textPredicate(node, fuzzy);
    case 'match': {
      const pattern = containsPattern(node.value);
      if (node.field === 'author') {
        const named = sql`exists (select from jsonb_array_elements_text(p.authors) a(name) where a.name ilike ${pattern})`;
        return node.op === '=' ? named : sql`not ${named}`;
      }
      const column = node.field === 'title' ? sql`p.title` : sql`coalesce(p.venue, '')`;
      return sql`${column} ${node.op === '=' ? sql`ilike` : sql`not ilike`} ${pattern}`;
    }
    case 'compare':
      return sql`coalesce(p.year ${sql.raw(COMPARE_SQL[node.op])} ${node.value}::int, false)`;
  }
}

/**
 * An id set found once through the GIN index, never `p.search @@ q` per row: that reads each row's whole
 * vector once per term, and a chain of negated words took seconds.
 */
function textPredicate(node: Extract<SearchNode, { kind: 'text' }>, fuzzy: boolean): SQL {
  if (node.include.length === 0) {
    const excluded = sql`websearch_to_tsquery('english', ${node.exclude.join(' or ')})`;
    return sql`p.id not in (select s.id from papers s where s.search @@ ${excluded})`;
  }
  const matches = sql`s.search @@ ${tsquery(websearchOf(node))}`;
  // A phrase or a negation means exactly what it says.
  const title = fuzzy && prefixOf(node) !== null ? sql` or s.title % ${node.include.join(' ')}` : sql``;
  return sql`p.id in (select s.id from papers s where ${matches}${title})`;
}

/** An OR, its plain text as one query: one scan of the index, where eight common words each read most of it. */
function anyOf(items: SearchNode[]): SQL {
  const isText = (i: SearchNode) => i.kind === 'text' && i.include.length > 0;
  const words = items.flatMap((i) => (i.kind === 'text' && isText(i) ? [tsquery(websearchOf(i))] : []));
  const parts = items.filter((i) => !isText(i)).map((i) => predicate(i, false));
  if (words.length > 0) {
    parts.push(sql`p.id in (select s.id from papers s where s.search @@ (${sql.join(words, sql` || `)}))`);
  }
  return sql`(${sql.join(parts, sql` or `)})`;
}

/** Whether a search has words that could be a misspelled title. */
function hasPlainWords(node: SearchNode | null): boolean {
  if (node === null) return false;
  if (node.kind === 'and' || node.kind === 'or') return node.items.some(hasPlainWords);
  return node.kind === 'text' && prefixOf(node) !== null;
}

function ordering(sort: SearchSort, node: SearchNode | null): SQL[] {
  const activity = [sql`c.updated_at desc nulls last`, sql`p.year desc nulls last`];
  const required = requiredText(node);
  switch (sort) {
    case 'relevance':
      if (required === null) return activity;
      return [
        sql`ts_rank_cd(p.search, ${tsquery(websearchOf(required))}) + similarity(p.title, ${required.include.join(' ')}) desc`,
      ];
    case 'activity':
      return activity;
    case 'newest':
      return [sql`p.year desc nulls last`, sql`p.created_at desc`];
    case 'oldest':
      return [sql`p.year asc nulls last`, sql`p.created_at asc`];
    case 'title':
      return [sql`lower(p.title)`];
  }
}

/**
 * One page of papers, and how many there are in all. Each hit carries one identifier, the one its address
 * uses. The page's ids are found first, so that identifiers are only looked up for the rows shown. Title
 * similarity is tried only when the words themselves find nothing: it reads far more rows, and a common
 * word has matches enough.
 */
export async function searchPapers(
  filter: SearchFilter = {},
  database: Database = getDb(),
): Promise<{ hits: SearchHit[]; total: number }> {
  const text = normalizeSearch(filter.q);
  const node = text === null ? null : parseSearch(text).node;
  const found = await readPage(filter, node, false, database);
  return found.total === 0 && hasPlainWords(node) ? readPage(filter, node, true, database) : found;
}

async function readPage(
  { venue, sort = 'relevance', page = 1, limit = SEARCH_PAGE_SIZE }: SearchFilter,
  node: SearchNode | null,
  fuzzy: boolean,
  database: Database,
): Promise<{ hits: SearchHit[]; total: number }> {
  const where = sql.join(
    [
      sql`p.merged_into is null`,
      ...(venue ? [sql`p.venue = ${venue}`] : []),
      ...(node === null ? [] : [predicate(node, fuzzy)]),
    ],
    sql` and `,
  );
  const order = sql.join([...ordering(sort, node), sql`p.id`], sql`, `);
  const [{ rows: counted }, { rows }] = await Promise.all([
    database.execute<{ total: number }>(sql`select count(*)::int as total from papers p where ${where}`),
    database.execute<SearchHit & Record<string, unknown>>(sql`
      select i.scheme, i.value, p.title, p.authors, left(p.abstract, 400) as abstract, p.year, p.venue,
             c.pdf ->> 'url' as pdf, coalesce(c.thumbnail ->> 'url', pc.url) as cover
      from unnest(array(
        select p.id from papers p
        left join page_current c on c.paper_id = p.id
        where ${where}
        order by ${order}
        limit ${limit} offset ${(page - 1) * limit}
      )) with ordinality as shown(id, position)
      join papers p on p.id = shown.id
      left join page_current c on c.paper_id = p.id
      left join pdf_covers pc on pc.sha256 = c.pdf ->> 'sha256'
      cross join lateral (
        select scheme, value from paper_identifiers
        where paper_id = p.id
        order by array_position(array['arxiv', 'doi', 'openreview'], scheme)
        limit 1
      ) i
      order by shown.position
    `),
  ]);
  return { hits: rows, total: counted[0].total };
}

/** The venues with the most papers, for the home page's filter. */
export async function topVenues(limit = 8, database: Database = getDb()): Promise<string[]> {
  const { rows } = await database.execute<{ venue: string }>(sql`
    select venue from papers
    where merged_into is null and venue is not null
    group by venue
    order by count(*) desc, venue
    limit ${limit}
  `);
  return rows.map((r) => r.venue);
}
