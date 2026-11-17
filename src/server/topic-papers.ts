import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { formatIdentifier, keyedPagePath } from '@/lib/kinds';
import type { SubmissionStatus, VenueForms } from '@/lib/submissions';
import { scoreFieldsOf, type ScoreField } from './scope-stats';
import { pageSummaries } from './plugins/pages';

/**
 * A topic's papers (`handoffs/pages.md` Phase 5), rolled up from its narrower topics, sortable by date, venue and
 * score: each with the topic it is in (when that's a narrower one), whether it introduced the topic, and its
 * submission (accepted first, else the latest) with its review score.
 *
 * **The score** is the mean, over the submission's reviews, of its venue's first score field (the overall rating,
 * `scoreFieldsOf`), shown on the venue's own scale ("6.2 of 10"). Sorting by score compares where each mean sits in
 * its venue's range, since a 6 at one venue and a 6 at another are different scales; papers with no score go last.
 */

export const TOPIC_PAPER_SORTS = ['date', 'venue', 'score'] as const;
export type TopicPaperSort = (typeof TOPIC_PAPER_SORTS)[number];

export interface TopicPaper {
  paperId: string;
  title: string;
  year: number | null;
  /** It introduced the topic (or the narrower topic it is in). */
  introduces: boolean;
  /** The narrower topic it is in, when it isn't in this one directly. */
  via: { key: string; name: string } | null;
  venue: { id: string; name: string; key: string | null } | null;
  status: SubmissionStatus | null;
  decision: string | null;
  score: { mean: number; min: number | null; max: number | null; label: string } | null;
}

export interface TopicPapers {
  total: number;
  papers: TopicPaper[];
  nextOffset: number | null;
}

/** As many as a topic's list reads at once: sorting happens over all of them. */
const MAX_ROWS = 5_000;

const SCORE_RE = '^\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?::|$)';

/** Where a mean sits in its field's range, 0 to 1; the mean itself when the form gives no range. */
function position(score: TopicPaper['score']): number | null {
  if (!score) return null;
  if (score.min === null || score.max === null || score.max <= score.min) return score.mean;
  return (score.mean - score.min) / (score.max - score.min);
}

export function sortTopicPapers(papers: TopicPaper[], sort: TopicPaperSort): TopicPaper[] {
  const byDate = (a: TopicPaper, b: TopicPaper) =>
    (b.year ?? -1) - (a.year ?? -1) || a.title.localeCompare(b.title, 'en');
  if (sort === 'date') return papers.toSorted(byDate);
  if (sort === 'venue') {
    return papers.toSorted((a, b) => {
      if (!a.venue !== !b.venue) return a.venue ? -1 : 1;
      return (a.venue?.name ?? '').localeCompare(b.venue?.name ?? '', 'en') || byDate(a, b);
    });
  }
  return papers.toSorted((a, b) => {
    const x = position(a.score);
    const y = position(b.score);
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    return (y ?? 0) - (x ?? 0) || byDate(a, b);
  });
}

/** Every paper of a topic, rolled up, unsorted. */
async function readTopicPapers(topicId: string, database: Database): Promise<TopicPaper[]> {
  const { rows } = await database.execute<{
    paper_id: string;
    title: string;
    year: number | null;
    introduces: boolean;
    via_key: string | null;
    via_name: string | null;
    submission_id: string | null;
    venue_id: string | null;
    venue_name: string | null;
    venue_key: string | null;
    status: SubmissionStatus | null;
    decision: string | null;
  }>(sql`
    with scopes as (
      select ${topicId}::uuid as id union select page_id from page_ancestors where ancestor_id = ${topicId}
    ),
    members as (
      select m.paper_id, bool_or(m.via = 'introduces-topic') as introduces,
             bool_or(m.scope_page_id = ${topicId}) as direct,
             (array_agg(m.scope_page_id order by m.scope_page_id))[1] as via_page
        from page_members m
       where m.scope_page_id in (select id from scopes)
       group by m.paper_id
       limit ${MAX_ROWS}
    ),
    latest as (
      select distinct on (s.paper_id) s.paper_id, s.id, s.venue_id, s.status, s.decision
        from submissions s
       where s.paper_id in (select paper_id from members)
       order by s.paper_id, (s.status = 'accepted') desc, s.fetched_at desc, s.id
    )
    select m.paper_id, p.title, p.year, m.introduces,
           case when m.direct then null else vp.key end as via_key,
           case when m.direct then null else coalesce(vc.name, vp.key) end as via_name,
           l.id as submission_id, l.venue_id, v.name as venue_name, l.status, l.decision,
           (select vpage.key from page_scope_names n join pages vpage on vpage.id = n.page_id and vpage.kind = 'venue'
             where n.name = l.venue_id order by vpage.key limit 1) as venue_key
      from members m
      join papers p on p.id = m.paper_id
      left join pages vp on vp.id = m.via_page
      left join page_current vc on vc.page_id = m.via_page
      left join latest l on l.paper_id = m.paper_id
      left join venues v on v.id = l.venue_id
  `);
  const scores = await submissionScores(
    database,
    rows.flatMap((row) => (row.submission_id && row.venue_id ? [{ id: row.submission_id, venue: row.venue_id }] : [])),
  );
  return rows.map((row) => ({
    paperId: row.paper_id,
    title: row.title,
    year: row.year,
    introduces: row.introduces,
    via: row.via_key ? { key: row.via_key, name: row.via_name ?? row.via_key } : null,
    venue: row.venue_id ? { id: row.venue_id, name: row.venue_name ?? row.venue_id, key: row.venue_key } : null,
    status: row.status,
    decision: row.decision,
    score: (row.submission_id && scores.get(row.submission_id)) || null,
  }));
}

/** Each submission's mean over its reviews of its venue's first score field. */
async function submissionScores(
  database: Database,
  list: readonly { id: string; venue: string }[],
): Promise<Map<string, NonNullable<TopicPaper['score']>>> {
  const out = new Map<string, NonNullable<TopicPaper['score']>>();
  if (list.length === 0) return out;
  const venueIds = [...new Set(list.map((s) => s.venue))];
  const { rows: venueRows } = await database.execute<{ id: string; forms: VenueForms; invitations: string[] }>(sql`
    select v.id, v.forms,
           array(select distinct n.invitation from submissions s
                   join submission_notes n on n.submission_id = s.id and n.kind = 'review'
                  where s.venue_id = v.id) as invitations
      from venues v
     where v.id in (${sql.join(
       venueIds.map((id) => sql`${id}`),
       sql`, `,
     )})
  `);
  const fields = new Map<string, ScoreField>();
  for (const row of venueRows) {
    const first = scoreFieldsOf(row.forms ?? {}, row.invitations)[0];
    if (first) fields.set(row.id, first);
  }
  const wanted = list.filter((s) => fields.has(s.venue));
  if (wanted.length === 0) return out;
  const { rows } = await database.execute<{ id: string; mean: number }>(sql`
    with subs as (select * from jsonb_to_recordset(${JSON.stringify(
      wanted.map((s) => ({ id: s.id, key: fields.get(s.venue)!.key })),
    )}::jsonb) as x(id uuid, key text)),
    scores as (
      select s.id,
             case when jsonb_typeof(n.content -> s.key) = 'number' then (n.content ->> s.key)::float8
                  else (regexp_match(n.content ->> s.key, ${SCORE_RE}))[1]::float8 end as score
        from subs s
        join submission_notes n on n.submission_id = s.id and n.kind = 'review'
    )
    select id, avg(score) as mean from scores where score is not null group by id
  `);
  const venueOf = new Map(wanted.map((s) => [s.id, s.venue]));
  for (const row of rows) {
    const field = fields.get(venueOf.get(row.id)!)!;
    out.set(row.id, { mean: Number(row.mean), min: field.min, max: field.max, label: field.label });
  }
  return out;
}

/** A page of a topic's papers, sorted. */
export async function topicPapers(
  topicId: string,
  options: { sort?: TopicPaperSort; offset?: number; limit?: number; database?: Database } = {},
): Promise<TopicPapers> {
  const { sort = 'date', offset = 0, limit = 50, database = getDb() } = options;
  const all = sortTopicPapers(await readTopicPapers(topicId, database), sort);
  const papers = all.slice(offset, offset + limit);
  const next = offset + papers.length;
  return { total: all.length, papers, nextOffset: next < all.length ? next : null };
}

/** A topic's papers as the page and `GET /pages/{identifier}/topic-papers` give them: by public identifier. */
export interface PresentedTopicPapers {
  total: number;
  papers: {
    title: string;
    identifier: string | null;
    address: string | null;
    year: number | null;
    introduces: boolean;
    via: { identifier: string; address: string; name: string } | null;
    venue: { id: string; name: string; identifier: string | null; address: string | null } | null;
    status: SubmissionStatus | null;
    decision: string | null;
    score: { mean: number; min: number | null; max: number | null; label: string } | null;
  }[];
  nextOffset: number | null;
}

export async function presentTopicPapers(
  topicId: string,
  options: { sort?: TopicPaperSort; offset?: number; limit?: number; database?: Database } = {},
): Promise<PresentedTopicPapers> {
  const found = await topicPapers(topicId, options);
  const summaries = await pageSummaries(
    found.papers.map((p) => p.paperId),
    options.database,
  );
  return {
    total: found.total,
    nextOffset: found.nextOffset,
    papers: found.papers.map(({ paperId, via, venue, score, ...paper }) => {
      const summary = summaries.get(paperId);
      return {
        ...paper,
        identifier: summary?.identifier ?? null,
        address: summary?.address ?? null,
        via: via
          ? {
              identifier: formatIdentifier({ kind: 'topic', key: via.key }),
              address: keyedPagePath('topic', via.key),
              name: via.name,
            }
          : null,
        venue: venue
          ? {
              id: venue.id,
              name: venue.name,
              identifier: venue.key ? formatIdentifier({ kind: 'venue', key: venue.key }) : null,
              address: venue.key ? keyedPagePath('venue', venue.key) : null,
            }
          : null,
        score: score ? { ...score, mean: Math.round(score.mean * 100) / 100 } : null,
      };
    }),
  };
}
