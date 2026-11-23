import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  containsPattern,
  DEFAULT_SCOPES,
  parseSearch,
  positiveText,
  prefixOf,
  requiredText,
  type SearchNode,
  type SearchScope,
  websearchOf,
} from '@/lib/query';
import { CATEGORY_LABEL } from '@/lib/labeled-links';
import { MARK_END, MARK_START, normalizeSearch, prefixTsquery, type SearchSort } from '@/lib/search';

export const SEARCH_PAGE_SIZE = 50;

export interface SearchHit {
  scheme: 'arxiv' | 'doi' | 'openreview';
  value: string;
  /** Its page's short id: the paper is at `/s/<shortId>`. */
  shortId: number;
  title: string;
  authors: string[];
  abstract: string | null;
  year: number | null;
  venue: string | null;
  /** The copy this site hosts: its newest version's PDF. */
  pdf: string | null;
  /**
   * The paper's picture: the thumbnail its authors chose, or else the hosted PDF's first page
   * (`pdf_documents.cover_url`), once one has been rendered.
   */
  cover: string | null;
  /** The files whose words matched, best first, when the search looked in files (`in:page`, `in:reviews`). */
  matches: SearchMatch[];
  /** How many of its files matched in all; `matches` holds the first few. */
  matchCount: number;
}

/** A file that matched a search: a hit names it, so the page can point at the review or section. */
export interface SearchMatch {
  /** Its path in the page's repo, such as `community/10-summary.md` or `reviews/openreview/x/notes/y.json`. */
  path: string;
  /** Its search document's kind: `section`, `link`, `version`, `picture`, `submission`, `note`. */
  kind: string;
  /** What the file calls itself, when it says: a section's title, a link's label, a review's signature. */
  label: string | null;
  /**
   * A few of its words around the match. Matched words sit between {@link MARK_START} and {@link MARK_END},
   * private-use characters that indexed text never holds; everything else is plain text.
   */
  snippet: string;
}

/** Files matched per hit that are shown. */
export const MATCHES_PER_HIT = 3;

export interface SearchFilter {
  /** The search syntax (`lib/query.ts`). Without one, every paper is listed. */
  q?: string | null;
  /** One venue, exactly. */
  venue?: string | null;
  sort?: SearchSort;
  /** Only the papers this account follows. */
  followedBy?: string | null;
  /** Only the papers this account is an author of, or has claimed to be (as on My papers). */
  authoredBy?: string | null;
  /** Leave out the papers this account follows: they are pinned above the list. */
  exceptFollowedBy?: string | null;
  /** Leave out the papers this account is an author of, or has claimed to be. */
  exceptAuthoredBy?: string | null;
  /** From 1. */
  page?: number;
  limit?: number;
}

/** The papers an account follows, as a predicate on `papers p`. */
function followed(accountId: string): SQL {
  return sql`p.id in (select f.paper_id from paper_follows f where f.account_id = ${accountId}::uuid)`;
}

/** The papers an account is an author of, or has asked to be (`server/my-papers.ts`'s `authoredPapers`). */
function authored(accountId: string): SQL {
  return sql`p.id in (select a.paper_id from author_claims a where a.account_id = ${accountId}::uuid and a.status in ('confirmed', 'pending'))`;
}

/** The papers in a category (its `in-category` members, `page_members`) that `which` picks, on `cp` and `cc`. */
function inCategory(which: SQL): SQL {
  return sql`p.id in (select m.paper_id from page_members m join pages cp on cp.id = m.scope_page_id left join page_current cc on cc.page_id = cp.id where m.via = ${CATEGORY_LABEL} and cp.kind = 'category' and ${which})`;
}

/** The query is a bound parameter; the prefix alternative is made of letters and digits only (`lib/search.ts`). */
function tsquery(q: string): SQL {
  const prefix = prefixTsquery(q);
  return prefix
    ? sql`(websearch_to_tsquery('english', ${q}) || to_tsquery('english', ${prefix}))`
    : sql`websearch_to_tsquery('english', ${q})`;
}

const COMPARE_SQL = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' } as const;

/** Where words are looked for (`lib/query.ts`'s `in:`). */
interface Scopes {
  /** Titles and abstracts, `papers.search`. */
  paper: boolean;
  /** `search_docs` scopes. */
  files: Exclude<SearchScope, 'paper'>[];
}

function scopesOf(set: ReadonlySet<SearchScope>): Scopes {
  return { paper: set.has('paper'), files: [...set].filter((s): s is Exclude<SearchScope, 'paper'> => s !== 'paper') };
}

/** Papers with a file in scope whose words match `q`, through the GIN index on `search_docs.tsv`. */
function inFiles(q: SQL, scopes: Scopes): SQL {
  return sql`p.id in (select d.page_id from search_docs d where d.scope = any(${sql.param(scopes.files)}::text[]) and d.tsv @@ ${q})`;
}

/** Papers whose title and abstract, or files in scope, match `q`; `title` also lets a misspelled title in. */
function matching(q: SQL, scopes: Scopes, title: SQL = sql``): SQL {
  const sources: SQL[] = [];
  if (scopes.paper) sources.push(sql`p.id in (select s.id from papers s where s.search @@ ${q}${title})`);
  if (scopes.files.length > 0) sources.push(inFiles(q, scopes));
  return sources.length === 1 ? sources[0] : sql`(${sql.join(sources, sql` or `)})`;
}

/**
 * A parsed search as a predicate on `papers p`. Every value is bound; operators come from the fixed map
 * above. `fuzzy`: plain words may also be a misspelled title.
 */
function predicate(node: SearchNode, fuzzy: boolean, scopes: Scopes): SQL {
  switch (node.kind) {
    case 'and':
    case 'or': {
      if (node.kind === 'or' && !fuzzy) return anyOf(node.items, scopes);
      const parts = node.items.map((item) => predicate(item, fuzzy, scopes));
      return sql`(${sql.join(parts, node.kind === 'and' ? sql` and ` : sql` or `)})`;
    }
    case 'not':
      return sql`not ${predicate(node.item, fuzzy, scopes)}`;
    case 'text':
      return textPredicate(node, fuzzy, scopes);
    case 'match': {
      const pattern = containsPattern(node.value);
      if (node.field === 'category') {
        const inOne = inCategory(
          sql`(cp.key ilike ${pattern} or coalesce(cc.kind_file ->> 'name', '') ilike ${pattern})`,
        );
        return node.op === '=' ? inOne : sql`not ${inOne}`;
      }
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
 * vector once per term, and a chain of negated words took seconds. In files, the words of one text node must
 * all be in one file (one search document), so a hit can name it.
 */
function textPredicate(node: Extract<SearchNode, { kind: 'text' }>, fuzzy: boolean, scopes: Scopes): SQL {
  if (node.include.length === 0) {
    const excluded = sql`websearch_to_tsquery('english', ${node.exclude.join(' or ')})`;
    return sql`not ${matching(excluded, scopes)}`;
  }
  // A phrase or a negation means exactly what it says.
  const title = fuzzy && prefixOf(node) !== null ? sql` or s.title % ${node.include.join(' ')}` : sql``;
  return matching(tsquery(websearchOf(node)), scopes, title);
}

/** An OR, its plain text as one query: one scan of the index, where eight common words each read most of it. */
function anyOf(items: SearchNode[], scopes: Scopes): SQL {
  const isText = (i: SearchNode) => i.kind === 'text' && i.include.length > 0;
  const words = items.flatMap((i) => (i.kind === 'text' && isText(i) ? [tsquery(websearchOf(i))] : []));
  const parts = items.filter((i) => !isText(i)).map((i) => predicate(i, false, scopes));
  if (words.length > 0) parts.push(matching(sql`(${sql.join(words, sql` || `)})`, scopes));
  return sql`(${sql.join(parts, sql` or `)})`;
}

/** Every word the search asks for, as one query: what a matched file's rank and snippet go by. `null`: none. */
function wantedWords(node: SearchNode | null): SQL | null {
  const texts = positiveText(node);
  return texts.length === 0
    ? null
    : sql`(${sql.join(
        texts.map((t) => tsquery(websearchOf(t))),
        sql` || `,
      )})`;
}

/** Whether a search has words that could be a misspelled title. */
function hasPlainWords(node: SearchNode | null): boolean {
  if (node === null) return false;
  if (node.kind === 'and' || node.kind === 'or') return node.items.some(hasPlainWords);
  return node.kind === 'text' && prefixOf(node) !== null;
}

/**
 * The best rank among each paper's matching files, as `fr(page_id, rank)`, when files are searched by relevance.
 * One pass over the matching documents, grouped, rather than a lookup per matching paper.
 */
function fileRanks(sort: SearchSort, node: SearchNode | null, scopes: Scopes): SQL {
  const wanted = sort === 'relevance' && scopes.files.length > 0 ? wantedWords(node) : null;
  if (wanted === null) return sql``;
  return sql`left join (
    select d.page_id, max(ts_rank_cd(d.tsv, ${wanted})) as rank from search_docs d
    where d.scope = any(${sql.param(scopes.files)}::text[]) and d.tsv @@ ${wanted}
    group by d.page_id
  ) fr on fr.page_id = p.id`;
}

/**
 * Relevance is still the title and abstract's (`papers.search`) when they are searched; a search in files adds
 * the best rank among the paper's matching files (`fileRanks`), so that alone it ranks by them.
 */
function ordering(sort: SearchSort, node: SearchNode | null, scopes: Scopes): SQL[] {
  const activity = [sql`c.updated_at desc nulls last`, sql`p.year desc nulls last`];
  const required = requiredText(node);
  switch (sort) {
    case 'relevance': {
      const words = scopes.paper ? required : null;
      const wanted = scopes.files.length > 0 ? wantedWords(node) : null;
      if (words === null && wanted === null) return activity;
      const ranks: SQL[] = [];
      if (words) {
        ranks.push(
          sql`ts_rank_cd(p.search, ${tsquery(websearchOf(words))}) + similarity(p.title, ${words.include.join(' ')})`,
        );
      }
      if (wanted) ranks.push(sql`coalesce(fr.rank, 0)`);
      return [sql`${sql.join(ranks, sql` + `)} desc`];
    }
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
  const parsed = text === null ? null : parseSearch(text);
  const node = parsed?.node ?? null;
  const scopes = scopesOf(parsed?.scopes ?? DEFAULT_SCOPES);
  let found = await readPage(filter, node, false, scopes, database);
  if (found.total === 0 && scopes.paper && hasPlainWords(node))
    found = await readPage(filter, node, true, scopes, database);
  const hits = await withMatches(found.hits, node, scopes, database);
  return { hits, total: found.total };
}

type Found = Omit<SearchHit, 'matches' | 'matchCount'> & { id: string };

async function readPage(
  {
    venue,
    sort = 'relevance',
    page = 1,
    limit = SEARCH_PAGE_SIZE,
    followedBy,
    authoredBy,
    exceptFollowedBy,
    exceptAuthoredBy,
  }: SearchFilter,
  node: SearchNode | null,
  fuzzy: boolean,
  scopes: Scopes,
  database: Database,
): Promise<{ hits: Found[]; total: number }> {
  const where = sql.join(
    [
      sql`p.merged_into is null`,
      ...(venue ? [sql`p.venue = ${venue}`] : []),
      ...(followedBy ? [followed(followedBy)] : []),
      ...(authoredBy ? [authored(authoredBy)] : []),
      ...(exceptFollowedBy ? [sql`not ${followed(exceptFollowedBy)}`] : []),
      ...(exceptAuthoredBy ? [sql`not ${authored(exceptAuthoredBy)}`] : []),
      ...(node === null ? [] : [predicate(node, fuzzy, scopes)]),
    ],
    sql` and `,
  );
  const order = sql.join([...ordering(sort, node, scopes), sql`p.id`], sql`, `);
  const [{ rows: counted }, { rows }] = await Promise.all([
    database.execute<{ total: number }>(sql`select count(*)::int as total from papers p where ${where}`),
    database.execute<Found & Record<string, unknown>>(sql`
      select p.id, i.scheme, i.value, pg.short_id as "shortId", p.title, p.authors, left(p.abstract, 400) as abstract, p.year, p.venue,
             c.pdf ->> 'url' as pdf, coalesce(c.thumbnail ->> 'url', pd.cover_url) as cover
      from unnest(array(
        select p.id from papers p
        left join page_current c on c.page_id = p.id
        ${fileRanks(sort, node, scopes)}
        where ${where}
        order by ${order}
        limit ${limit} offset ${(page - 1) * limit}
      )) with ordinality as shown(id, position)
      join papers p on p.id = shown.id
      join pages pg on pg.id = p.id
      left join page_current c on c.page_id = p.id
      left join pdf_documents pd on pd.sha256 = c.pdf ->> 'sha256'
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

/** `ts_headline`'s options: a fragment or two around the matched words, marked with private-use characters. */
const HEADLINE = `MaxWords=24, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … ", StartSel=${MARK_START}, StopSel=${MARK_END}`;

/**
 * The shown hits with the files that matched, when the search looked in files: the best few of each paper's,
 * by rank, with a snippet. Only the shown page's papers are read, so `ts_headline` runs on a handful of files.
 */
async function withMatches(
  found: Found[],
  node: SearchNode | null,
  scopes: Scopes,
  database: Database,
): Promise<SearchHit[]> {
  const wanted = scopes.files.length > 0 ? wantedWords(node) : null;
  // The paper's id stays inside: addresses use its identifiers.
  const bare = ({ scheme, value, shortId, title, authors, abstract, year, venue, pdf, cover }: Found): SearchHit => ({
    ...{ scheme, value, shortId, title, authors, abstract, year, venue, pdf, cover },
    matches: [],
    matchCount: 0,
  });
  if (wanted === null || found.length === 0) return found.map(bare);

  const { rows } = await database.execute<{
    paper_id: string;
    path: string;
    kind: string;
    label: string | null;
    snippet: string;
    total: number;
  }>(sql`
    select page_id as paper_id, path, kind, total::int,
           coalesce(fields ->> 'title', fields ->> 'label', fields ->> 'signature') as label,
           ts_headline('english', text, ${wanted}, ${HEADLINE}) as snippet
    from (
      select d.*, row_number() over w as place, count(*) over (partition by d.page_id) as total
      from search_docs d
      where d.page_id = any(${sql.param(found.map((hit) => hit.id))}::uuid[])
        and d.scope = any(${sql.param(scopes.files)}::text[])
        and d.tsv @@ ${wanted}
      window w as (partition by d.page_id order by ts_rank_cd(d.tsv, ${wanted}) desc, d.path, d.n)
    ) ranked
    where place <= ${MATCHES_PER_HIT}
    order by page_id, place
  `);
  const byPaper = new Map<string, { matches: SearchMatch[]; total: number }>();
  for (const row of rows) {
    const entry = byPaper.get(row.paper_id) ?? { matches: [], total: row.total };
    entry.matches.push({ path: row.path, kind: row.kind, label: row.label, snippet: row.snippet });
    byPaper.set(row.paper_id, entry);
  }
  return found.map((hit) => {
    const entry = byPaper.get(hit.id);
    return { ...bare(hit), matches: entry?.matches ?? [], matchCount: entry?.total ?? 0 };
  });
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
