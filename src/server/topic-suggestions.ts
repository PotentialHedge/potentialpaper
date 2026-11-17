import { sql, type SQL } from 'drizzle-orm';
import type { Database } from '@/db';
import type { Consumer } from './consumers/types';
import { mustPage } from './pages/kinds';
import type { Writer } from './pages/projections';

/**
 * "Might belong here" (`handoffs/pages.md` Phase 5): papers a topic might have, which a person confirms (a link,
 * `topic-pages.ts`'s `decideSuggestion`) or dismisses. Machines only suggest. Kept by the `topic-suggestions` consumer
 * in `topic_suggestions` from two signals, each matched against the topic's name and every alias:
 *
 * - **keywords** the paper's authors gave OpenReview (`submissions.keywords`, from `submission.json`): a keyword with
 *   the same words as the name (English stems, any order: "state space models" for "State-space model"); score 3;
 * - **the title**, the name as a phrase in it; score 2; **the abstract**, as a phrase there, for names of two words or
 *   more (one word in an abstract says little); score 1.
 *
 * A paper's score is the sum over the reasons it has (a keyword and its title: 5), its reason the strongest. Papers
 * already in the topic (directly) aren't suggested. **Decisions stay**: a row that isn't `open` (dismissed, or
 * confirmed) is never rewritten or deleted here, so a dismissed suggestion doesn't come back. Each topic keeps its
 * best `MAX_PER_TOPIC`.
 *
 * A topic's event (its names may have changed) recomputes the topic against every paper; a paper's event (its
 * keywords, title or topics may have changed) recomputes the paper against every topic. The seam, if this grows: the
 * keyword match reads every submission's keywords for a topic; an index on their normalised words would make it a
 * lookup.
 */

export const MAX_PER_TOPIC = 200;
/** Names shorter than this suggest nothing: "AI" is in too many titles. */
const MIN_NAME = 3;

/** The words of a text as a set of English stems, sorted: equal for "State-space models" and "state space model". */
const WORDS = (text: SQL) => sql`array(select unnest(tsvector_to_array(to_tsvector('english', ${text}))) order by 1)`;

/** Every (topic, name) of the topics `topics` selects: a topic's name and aliases, not merged, long enough. */
function namesSql(topics: SQL | null) {
  return sql`
    select t.id as topic_id, n.name, phraseto_tsquery('english', n.name) as q,
           ${WORDS(sql`n.name`)} as words
      from pages t
      join page_current c on c.page_id = t.id
      cross join lateral (
        select c.kind_file ->> 'name' as name
        union
        select jsonb_array_elements_text(coalesce(c.kind_file -> 'aliases', '[]'::jsonb))
      ) n
     where t.kind = 'topic' and t.merged_into is null and n.name is not null and length(n.name) >= ${MIN_NAME}
       ${topics ? sql`and t.id in (${topics})` : sql``}
  `;
}

/**
 * The suggestions for the topics `topics` selects and the papers `papers` selects (all when `null`), best first per
 * topic, each paper once per topic.
 */
function candidatesSql(topics: SQL | null, papers: SQL | null) {
  const paperFilter = (column: SQL) => (papers ? sql`and ${column} in (${papers})` : sql``);
  return sql`
    with names as materialized (${namesSql(topics)}),
    keywords as materialized (
      select s.paper_id, ${WORDS(sql`k.keyword`)} as words
        from submissions s
        cross join lateral unnest(s.keywords) k(keyword)
       where cardinality(s.keywords) > 0 ${paperFilter(sql`s.paper_id`)}
    ),
    hits as (
      select n.topic_id, k.paper_id, 'keyword' as reason, n.name as matched, 3.0 as score
        from names n
        join keywords k on k.words = n.words
       where cardinality(n.words) > 0
      union all
      select n.topic_id, p.id,
             case when to_tsvector('english', p.title) @@ n.q then 'title' else 'abstract' end,
             n.name,
             case when to_tsvector('english', p.title) @@ n.q then 2.0 else 1.0 end
        from names n
        join papers p on p.search @@ n.q
       where p.merged_into is null and numnode(n.q) > 0 ${paperFilter(sql`p.id`)}
         and (to_tsvector('english', p.title) @@ n.q or cardinality(n.words) >= 2)
    ),
    per_reason as (
      select topic_id, paper_id, reason, min(matched) as matched, max(score) as score
        from hits group by topic_id, paper_id, reason
    ),
    per_paper as (
      select topic_id, paper_id,
             (array_agg(reason order by score desc))[1] as reason,
             (array_agg(matched order by score desc))[1] as matched,
             sum(score) as score
        from per_reason
       where not exists (select 1 from page_members m where m.scope_page_id = per_reason.topic_id
                                                      and m.paper_id = per_reason.paper_id)
       group by topic_id, paper_id
    ),
    ranked as (
      select pp.*, row_number() over (partition by topic_id order by score desc, p.year desc nulls last, paper_id) as rank
        from per_paper pp join papers p on p.id = pp.paper_id
    )
    select topic_id, paper_id, reason, matched, score from ranked where rank <= ${MAX_PER_TOPIC}
  `;
}

/** Writes the open suggestions of the topics and papers selected again, leaving people's decisions alone. */
async function rewrite(tx: Writer, topics: SQL | null, papers: SQL | null): Promise<void> {
  const where = sql.join(
    [
      sql`status = 'open'`,
      ...(topics ? [sql`topic_page_id in (${topics})`] : []),
      ...(papers ? [sql`paper_id in (${papers})`] : []),
    ],
    sql` and `,
  );
  await tx.execute(sql`delete from topic_suggestions where ${where}`);
  await tx.execute(sql`
    insert into topic_suggestions (topic_page_id, paper_id, reason, matched, score)
    ${candidatesSql(topics, papers)}
    on conflict (topic_page_id, paper_id) do nothing
  `);
}

/** A topic's suggestions, against every paper. */
export async function suggestForTopic(database: Database, topicId: string): Promise<void> {
  await database.transaction((tx) => rewrite(tx, sql`select ${topicId}::uuid`, null));
}

/** A paper's suggestions, against every topic. */
export async function suggestForPaper(database: Database, paperId: string): Promise<void> {
  await database.transaction((tx) => rewrite(tx, null, sql`select ${paperId}::uuid`));
}

export const topicSuggestionsConsumer: Consumer = {
  name: 'topic-suggestions',
  kinds: ['paper', 'topic'],
  async handle(pageId, _head, { database }) {
    const page = await mustPage(database, pageId);
    if (page.kind === 'topic') await suggestForTopic(database, pageId);
    else await suggestForPaper(database, pageId);
  },
  async reset({ database }) {
    // Only the machine's: what people decided stays.
    await database.execute(sql`delete from topic_suggestions where status = 'open'`);
  },
};
