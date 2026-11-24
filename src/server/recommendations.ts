import { sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  coreadVotes,
  NEAREST,
  scoreCandidates,
  sourceWeights,
  topSources,
  vectorVotes,
  type Interaction,
  type InteractionKind,
  type Vote,
} from '@/lib/recommend';
import { SIGNAL_REF_RE } from '@/lib/settings/core';
import { recommendationVectors } from './settings';
import { nearestPaperIds } from './signals';

/**
 * The home page's `recommended` sort, after acceptodds': what is near the papers the viewer deliberately acted on,
 * by the site's chosen vector signals, co-reading and links between pages (`lib/recommend.ts` scores it). Read-only
 * and computed per request; nothing is stored.
 *
 * Only the viewer's own acts are read: papers they are an author of (or have asked to be), follow, commented on or
 * edited. Never page views (`page_views` is built so it cannot name anyone). Co-reading is `page_transitions`, which
 * holds counts only, so nobody's reading shows through the scores.
 */

/** Acts (any kind) before the sort is offered, unless the viewer is an author of a paper here. */
export const MIN_INTERACTIONS = 2;

/** A viewer's scores, kept a minute so paging through the list does not rescan the vectors. */
const SCORES_TTL_MS = 60_000;
const MAX_CACHED = 500;
const cache = new Map<string, { at: number; value: Promise<Map<string, number>> }>();

/** The viewer's own acts on papers: per paper and kind, the latest. Merged papers count as their survivor. */
async function interactions(accountId: string, database: Database): Promise<Interaction[]> {
  const { rows } = await database.execute<{ paper_id: string; kind: InteractionKind; at: string }>(sql`
    select coalesce(p.merged_into, p.id) as paper_id, a.kind, max(a.at)::text as at
      from (
        select paper_id, 'authored' as kind, created_at as at from author_claims
         where account_id = ${accountId}::uuid and status in ('confirmed', 'pending')
        union all
        select paper_id, 'follow', created_at from paper_follows where account_id = ${accountId}::uuid
        union all
        select paper_id, 'comment', created_at from comments where account_id = ${accountId}::uuid and removed_at is null
        union all
        select page_id, 'edit', at from page_revisions where account_id = ${accountId}::uuid
      ) a
      join papers p on p.id = a.paper_id
     group by 1, 2
  `);
  return rows.map((r) => ({ paperId: r.paper_id, kind: r.kind, at: new Date(r.at) }));
}

/** Every recommended paper's score for `accountId`, by paper id; empty when they have acted on nothing. */
export function recommendationScores(
  accountId: string,
  database: Database = getDb(),
): Promise<ReadonlyMap<string, number>> {
  if (database !== getDb()) return computeScores(accountId, database);
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < SCORES_TTL_MS) return hit.value;
  const value = computeScores(accountId, database);
  cache.delete(accountId);
  cache.set(accountId, { at: Date.now(), value });
  value.catch(() => cache.delete(accountId));
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  return value;
}

async function computeScores(accountId: string, database: Database): Promise<Map<string, number>> {
  const weights = sourceWeights(await interactions(accountId, database));
  const sources = topSources(weights);
  if (sources.length === 0) return new Map();
  const ids = sql`${pgArray(sources)}::uuid[]`;

  const [coread, linked, vectors] = await Promise.all([
    // Both ways: where readers of a source went next, and where they came from.
    database.execute<{ source: string; target: string; count: number }>(sql`
      select t.source, t.target, sum(t.count)::int as count from (
        select from_page_id as source, to_page_id as target, count from page_transitions where from_page_id = any(${ids})
        union all
        select to_page_id, from_page_id, count from page_transitions where to_page_id = any(${ids})
      ) t join papers p on p.id = t.target and p.merged_into is null
       group by 1, 2
    `),
    // Both ways: papers a source's page links to, and those whose pages link to it.
    database.execute<{ source: string; target: string }>(sql`
      select distinct l.source, l.target from (
        select page_id as source, target_page_id as target from page_links
         where page_id = any(${ids}) and target_kind = 'paper' and target_page_id is not null
        union all
        select target_page_id, page_id from page_links
         where target_page_id = any(${ids}) and target_kind = 'paper'
      ) l join papers p on p.id = l.target and p.merged_into is null
    `),
    recommendationVectors(),
  ]);

  const signals = vectors.filter((ref) => SIGNAL_REF_RE.test(ref)).map((ref) => ref.split(':') as [string, string]);
  const nearest = await Promise.all(
    sources.flatMap((source) =>
      signals.map(async ([setId, signal]) =>
        vectorVotes(source, await nearestPaperIds(setId, signal, source, NEAREST, database)),
      ),
    ),
  );

  const votes: Vote[] = [
    ...coreadVotes(coread.rows),
    ...linked.rows.map((r) => ({ ...r, strength: 1, via: 'link' as const })),
    ...nearest.flat(),
  ];
  // Only the top sources vote, but every acted-on paper is left out of the scores.
  const voting = new Set(sources);
  return scoreCandidates(new Map([...weights].map(([id, w]) => [id, voting.has(id) ? w : 0])), votes);
}

/**
 * One bound parameter holding a Postgres array literal: Drizzle would spread a JS array into a list of parameters.
 * Only for uuids and numbers, which need no quoting.
 */
function pgArray(values: readonly (string | number)[]): string {
  return `{${values.join(',')}}`;
}

/** `(paper_id, score)` as a derived table to left join on `p.id`. */
export function scoresTable(scores: ReadonlyMap<string, number>): SQL {
  return sql`(select * from unnest(${pgArray([...scores.keys()])}::uuid[], ${pgArray([...scores.values()])}::float8[]) as r(paper_id, score))`;
}

/** Whether to offer the sort: the viewer is an author of a paper here, or has acted on papers `MIN_INTERACTIONS` times. */
export async function canRecommend(accountId: string, database: Database = getDb()): Promise<boolean> {
  const { rows } = await database.execute<{ ok: boolean }>(sql`
    select exists (select 1 from author_claims where account_id = ${accountId}::uuid and status in ('confirmed', 'pending'))
        or (select count(*) from (
              (select 1 from paper_follows where account_id = ${accountId}::uuid limit ${MIN_INTERACTIONS})
              union all (select 1 from comments where account_id = ${accountId}::uuid and removed_at is null limit ${MIN_INTERACTIONS})
              union all (select 1 from page_revisions r join papers p on p.id = r.page_id
                          where r.account_id = ${accountId}::uuid limit ${MIN_INTERACTIONS})
            ) x) >= ${MIN_INTERACTIONS} as ok
  `);
  return rows[0]?.ok ?? false;
}
