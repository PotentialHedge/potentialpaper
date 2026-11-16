import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { scopeState, scopeStats, submissionNotes, submissions, venues } from '@/db/schema';
import { KINDS, PAGE_KINDS } from '@/lib/kinds';
import { fieldStats, type FieldStats, type HideUntil, outcomeOf } from '@/lib/scope-stats';
import { type NoteForm, scoreOf, type SubmissionStatus, type VenueForms } from '@/lib/submissions';
import type { Consumer } from './consumers/types';
import { mustPage } from './pages/kinds';
import type { Reader } from './pages/repo';
import type { Writer } from './pages/projections';
import { pageSummaries } from './plugins/pages';

/**
 * Score statistics of the pages above the paper (`handoffs/plugins.md` Phase 4, data for plugins A): `scope_stats`,
 * per `(scope, venue, field)`, for every field a venue's review forms mark `score`.
 *
 * **When it is recomputed.** A scope's numbers come from `submissions` and `submission_notes` (the `reviews`
 * consumer) and `page_members`/`page_ancestors` (the `members` consumer), each with its own cursor, so this can't be
 * an ordinary consumer reading the same events: it might run before them. Instead those two consumers, inside the
 * transaction that changes their rows, **mark** the scopes affected (`markPaperScopes`, `markScopes`): the paper's
 * scopes before and after, a scope page and every scope above it, since statistics roll up. Marking sets
 * `scope_state.changed_at` and a `due_at` a few seconds ahead, pushed back by further marks but never more than a
 * minute past the first, so one scope is recomputed now and then during an import rather than on every paper. The
 * worker (`consumers:work`) runs `recomputeDueScopes` after every pass. Recomputing is idempotent: the scope's rows
 * are replaced whole from the tables.
 *
 * The `scope-stats` consumer exists for `consumers:rebuild -- scope-stats`: its `reset` empties the statistics and
 * marks every scope, and replaying events marks each page's scopes again. It also marks on any commit of a member
 * paper, which keeps `changed_at` (the bulk route's ETag) moving when a paper's title changes.
 */

/** How long a scope waits after a change before it is recomputed. */
export const DEBOUNCE = '5 seconds';
/** The longest a scope waits once it has changed, however often it changes again. */
export const MAX_WAIT = '1 minute';
/** How long a scope taken to be recomputed is held, should the worker die halfway. */
const LEASE = '5 minutes';

const SCOPE_KINDS = PAGE_KINDS.filter((kind) => KINDS[kind].scope);

/** Marks the scopes `ids` (a subquery of page ids) and every scope above them as changed. */
export async function markScopes(db: Writer, ids: SQL): Promise<void> {
  await db.execute(sql`
    insert into scope_state (scope_page_id, changed_at, dirty_since, due_at)
    select x.id, clock_timestamp(), clock_timestamp(), clock_timestamp() + ${DEBOUNCE}::interval
      from (
        select id from (${ids}) given(id)
        union
        select a.ancestor_id from page_ancestors a where a.page_id in (select id from (${ids}) given(id))
      ) x
      join pages p on p.id = x.id and p.kind in (${sql.join(
        SCOPE_KINDS.map((k) => sql`${k}`),
        sql`, `,
      )})
     -- One order for every writer, so two transactions marking overlapping scopes don't deadlock.
     order by x.id
    on conflict (scope_page_id) do update
       set changed_at = excluded.changed_at,
           dirty_since = coalesce(scope_state.dirty_since, excluded.dirty_since),
           due_at = least(excluded.due_at, coalesce(scope_state.dirty_since, excluded.dirty_since) + ${MAX_WAIT}::interval)
  `);
}

/** Marks the scopes a paper is in now (and those above them). Call it before and after membership changes. */
export async function markPaperScopes(db: Writer, paperId: string): Promise<void> {
  await markScopes(db, sql`select scope_page_id from page_members where paper_id = ${paperId}`);
}

/** A score field of a venue's review forms. */
export interface ScoreField {
  key: string;
  label: string;
  min: number | null;
  max: number | null;
}

/**
 * The score fields of a venue's review forms, in the forms' order: each form's `summary` first, then its fields. Only
 * fields the form marks `score`; `invitations` are the forms its reviews were written on.
 */
export function scoreFieldsOf(forms: VenueForms, invitations: readonly string[]): ScoreField[] {
  const out = new Map<string, ScoreField>();
  for (const invitation of [...invitations].sort()) {
    const form: NoteForm | undefined = Object.hasOwn(forms, invitation) ? forms[invitation] : undefined;
    if (!form) continue;
    const scores = form.fields.filter((f) => f.type === 'score');
    const summary = form.summary ?? [];
    const ordered = [
      ...summary.flatMap((key) => scores.filter((f) => f.key === key)),
      ...scores.filter((f) => !summary.includes(f.key)),
    ];
    for (const f of ordered) {
      if (!out.has(f.key)) out.set(f.key, { key: f.key, label: f.label, min: f.min ?? null, max: f.max ?? null });
    }
  }
  return [...out.values()];
}

/** A scope and the scopes under it, as a subquery. */
function scopePagesOf(scopeId: string) {
  return sql`select ${scopeId}::uuid as id union select page_id from page_ancestors where ancestor_id = ${scopeId}`;
}

/**
 * The submissions that count in a scope: every submission of its member papers, except that a paper that is a member
 * through a submission (a venue's) counts only its submissions to the venues the scope answers to.
 */
function scopeSubmissionsSql(scopeId: string) {
  return sql`
    select distinct s.id, s.venue_id, s.status
      from page_members m
      join submissions s on s.paper_id = m.paper_id
     where m.scope_page_id in (${scopePagesOf(scopeId)})
       and (m.via <> 'submission'
            or exists (select 1 from page_scope_names n where n.page_id = m.scope_page_id and n.name = s.venue_id))
  `;
}

/** A score as a field's value gives it: `6`, or `"6: marginally above"`. The same rule as `lib/submissions.ts`. */
const SCORE_RE = '^\\s*(-?\\d+(?:\\.\\d+)?)\\s*(?::|$)';

export interface ComputedField extends FieldStats {
  venueId: string;
  field: string;
  label: string;
  position: number;
  decisionsOut: boolean;
}

/** A scope's statistics, from the tables. */
export async function computeScopeStats(scopeId: string, database: Reader = getDb()): Promise<ComputedField[]> {
  const subs = scopeSubmissionsSql(scopeId);
  const { rows: venueRows } = await database.execute<{
    venue_id: string;
    forms: VenueForms;
    invitations: string[];
    decided: boolean;
  }>(sql`
    with subs as (${subs})
    select v.id as venue_id, v.forms,
           array(select distinct n.invitation from subs s2
                   join submission_notes n on n.submission_id = s2.id and n.kind = 'review'
                  where s2.venue_id = v.id) as invitations,
           exists (select 1 from submissions d where d.venue_id = v.id and d.status in ('accepted', 'rejected')) as decided
      from venues v
     where v.id in (select venue_id from subs)
  `);
  const fields = venueRows.flatMap((row) =>
    scoreFieldsOf(row.forms ?? {}, row.invitations).map((f, position) => ({ ...f, venue: row.venue_id, position })),
  );
  if (fields.length === 0) return [];

  // One aggregate: each submission's mean per field over its reviews, sorted, with its status alongside.
  const { rows } = await database.execute<{
    venue_id: string;
    field: string;
    means: number[];
    statuses: (SubmissionStatus | null)[];
  }>(sql`
    with subs as (${subs}),
    fields as (select * from jsonb_to_recordset(${JSON.stringify(fields.map((f) => ({ venue: f.venue, key: f.key })))}::jsonb)
                as f(venue text, key text)),
    means as (
      select s.id, s.venue_id, s.status, f.key,
             avg((regexp_match(n.content ->> f.key, ${SCORE_RE}))[1]::float8) as mean
        from subs s
        join fields f on f.venue = s.venue_id
        join submission_notes n on n.submission_id = s.id and n.kind = 'review'
       group by s.id, s.venue_id, s.status, f.key
    )
    select venue_id, key as field, array_agg(mean order by mean) as means, array_agg(status order by mean) as statuses
      from means where mean is not null
     group by venue_id, key
  `);
  const found = new Map(rows.map((row) => [`${row.venue_id}\n${row.field}`, row]));
  const decided = new Map(venueRows.map((row) => [row.venue_id, row.decided]));
  return fields.flatMap((f) => {
    const row = found.get(`${f.venue}\n${f.key}`);
    if (!row) return [];
    const means = row.means.map((value, i) => ({ value: Number(value), outcome: outcomeOf(row.statuses[i]) }));
    return [
      {
        ...fieldStats(means, f.min, f.max),
        venueId: f.venue,
        field: f.key,
        label: f.label,
        position: f.position,
        decisionsOut: decided.get(f.venue) ?? false,
      },
    ];
  });
}

/** Replaces a scope's rows of `scope_stats` with what the tables say now. */
export async function recomputeScope(scopeId: string, database: Database = getDb()): Promise<number> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`scope-stats:${scopeId}`}, 0))`);
    const computed = await computeScopeStats(scopeId, tx);
    await tx.delete(scopeStats).where(eq(scopeStats.scopePageId, scopeId));
    const computedAt = new Date();
    for (let at = 0; at < computed.length; at += 50) {
      await tx.insert(scopeStats).values(
        computed.slice(at, at + 50).map((c) => ({
          scopePageId: scopeId,
          venueId: c.venueId,
          field: c.field,
          label: c.label,
          position: c.position,
          min: c.min,
          max: c.max,
          count: c.count,
          values: c.values,
          bins: c.bins,
          byStatus: c.byStatus,
          decisionsOut: c.decisionsOut,
          computedAt,
        })),
      );
    }
    return computed.length;
  });
}

/**
 * Recomputes the scopes whose time has come (or every marked one, with `all`), a few at a time. Each is taken with a
 * lease, so two workers don't both do it, and let go only if nothing marked it again meanwhile. Returns how many were
 * done and, when some are still waiting, how long until the next is due.
 */
export async function recomputeDueScopes(
  options: { database?: Database; limit?: number; all?: boolean } = {},
): Promise<{ scopes: number; nextInMs: number | null }> {
  const { database = getDb(), limit = 20, all = false } = options;
  let done = 0;
  for (;;) {
    const { rows: taken } = await database.execute<{ scope_page_id: string; changed_at: string }>(sql`
      update scope_state set due_at = clock_timestamp() + ${LEASE}::interval
       where scope_page_id in (
         select scope_page_id from scope_state
          where due_at is not null and ${all ? sql`true` : sql`due_at <= clock_timestamp()`}
          order by due_at limit ${limit} for update skip locked)
      returning scope_page_id, changed_at::text
    `);
    for (const row of taken) {
      await recomputeScope(row.scope_page_id, database);
      await database.execute(sql`
        update scope_state set due_at = null, dirty_since = null, computed_at = clock_timestamp()
         where scope_page_id = ${row.scope_page_id} and changed_at = ${row.changed_at}::timestamptz
      `);
      done += 1;
    }
    if (taken.length < limit) break;
  }
  const { rows } = await database.execute<{ ms: number | null }>(sql`
    select (extract(epoch from min(due_at) - clock_timestamp()) * 1000)::float8 as ms from scope_state where due_at is not null
  `);
  const ms = rows[0]?.ms;
  return { scopes: done, nextInMs: ms === null || ms === undefined ? null : Math.max(0, Math.ceil(Number(ms))) };
}

export const scopeStatsConsumer: Consumer = {
  name: 'scope-stats',
  async handle(pageId, _head, { database }) {
    const page = await mustPage(database, pageId);
    if (page.kind === 'paper') await markPaperScopes(database, pageId);
    else if (KINDS[page.kind].scope) await markScopes(database, sql`select ${pageId}::uuid`);
  },
  async reset({ database }) {
    await database.execute(sql`truncate scope_stats`);
    await database.execute(sql`delete from scope_state`);
    await markScopes(database, sql`select id from pages`);
  },
};

// Reads.

export interface ScoreSummary {
  venue: { id: string; name: string };
  field: string;
  label: string;
  count: number;
  min: number | null;
  max: number | null;
  /** How many of each outcome. */
  byStatus: Record<string, number>;
  decisionsOut: boolean;
  /** Withheld by `plugins.venueStats.hideUntil` until the venue's decisions are out. */
  hidden: boolean;
  computedAt: string;
}

export interface ScoreDetail extends ScoreSummary {
  values: number[];
  bins: FieldStats['bins'];
  split: FieldStats['byStatus'];
}

function hiddenBy(hideUntil: HideUntil, decisionsOut: boolean): boolean {
  return hideUntil === 'decisions' && !decisionsOut;
}

/** A scope's venues and fields with their counts, in each venue's field order. */
export async function scopeScoreList(
  scopeId: string,
  hideUntil: HideUntil,
  database: Database = getDb(),
): Promise<ScoreSummary[]> {
  const rows = await database
    .select({
      venueId: scopeStats.venueId,
      venueName: venues.name,
      field: scopeStats.field,
      label: scopeStats.label,
      count: scopeStats.count,
      min: scopeStats.min,
      max: scopeStats.max,
      byStatus: scopeStats.byStatus,
      decisionsOut: scopeStats.decisionsOut,
      computedAt: scopeStats.computedAt,
    })
    .from(scopeStats)
    .leftJoin(venues, eq(venues.id, scopeStats.venueId))
    .where(eq(scopeStats.scopePageId, scopeId))
    .orderBy(sql`${scopeStats.count} desc`, asc(scopeStats.venueId), asc(scopeStats.position));
  // Venues with the most submissions first, keeping each venue's fields together and in order.
  const firstCount = new Map<string, number>();
  for (const row of rows) if (!firstCount.has(row.venueId)) firstCount.set(row.venueId, firstCount.size);
  return rows
    .map((row) => ({
      venue: { id: row.venueId, name: row.venueName ?? row.venueId },
      field: row.field,
      label: row.label,
      count: row.count,
      min: row.min,
      max: row.max,
      byStatus: Object.fromEntries(Object.entries(row.byStatus).map(([k, g]) => [k, g.count])),
      decisionsOut: row.decisionsOut,
      hidden: hiddenBy(hideUntil, row.decisionsOut),
      computedAt: row.computedAt.toISOString(),
      order: firstCount.get(row.venueId)!,
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ order, ...rest }) => (void order, rest));
}

/** One field's statistics at one venue in a scope; `null` when there are none. Hidden ones come without numbers. */
export async function scopeScoreField(
  scopeId: string,
  venueId: string,
  field: string,
  hideUntil: HideUntil,
  database: Database = getDb(),
): Promise<ScoreDetail | null> {
  const [row] = await database
    .select({ stats: scopeStats, venueName: venues.name })
    .from(scopeStats)
    .leftJoin(venues, eq(venues.id, scopeStats.venueId))
    .where(and(eq(scopeStats.scopePageId, scopeId), eq(scopeStats.venueId, venueId), eq(scopeStats.field, field)));
  if (!row) return null;
  const s = row.stats;
  const hidden = hiddenBy(hideUntil, s.decisionsOut);
  const empty = (g: { bins: FieldStats['bins'] }) => ({
    count: 0,
    values: [],
    bins: { ...g.bins, counts: g.bins.counts.map(() => 0) },
  });
  return {
    venue: { id: s.venueId, name: row.venueName ?? s.venueId },
    field: s.field,
    label: s.label,
    count: s.count,
    min: s.min,
    max: s.max,
    byStatus: Object.fromEntries(Object.entries(s.byStatus).map(([k, g]) => [k, g.count])),
    decisionsOut: s.decisionsOut,
    hidden,
    computedAt: s.computedAt.toISOString(),
    values: hidden ? [] : s.values,
    bins: hidden ? empty(s).bins : s.bins,
    split: hidden
      ? (Object.fromEntries(
          Object.entries(s.byStatus).map(([k, g]) => [k, empty(g)]),
        ) as unknown as FieldStats['byStatus'])
      : s.byStatus,
  };
}

/** When a scope last changed, for the bulk route's ETag; `null` if nothing has marked it yet. */
export async function scopeChangedAt(scopeId: string, database: Database = getDb()): Promise<Date | null> {
  const [row] = await database
    .select({ changedAt: scopeState.changedAt })
    .from(scopeState)
    .where(eq(scopeState.scopePageId, scopeId));
  return row?.changedAt ?? null;
}

/** Whether a scope has any score statistics: `page.hasScores` on a venue, topic or org. */
export async function scopeHasScores(scopeId: string, database: Reader = getDb()): Promise<boolean> {
  const { rows } = await database.execute<{ found: boolean }>(
    sql`select exists (select 1 from scope_stats where scope_page_id = ${scopeId} and count > 0) as found`,
  );
  return Boolean(rows[0]?.found);
}

// B: a scope's papers in bulk.

export const PAPER_FIELDS = ['submissions', 'scores', 'status'] as const;
export type PaperField = (typeof PAPER_FIELDS)[number];

export interface BulkReview {
  id: string;
  signature: string;
  /** Each score field of the venue's review forms the review gave, by key. */
  scores: Record<string, number>;
  url: string | null;
  license: string;
}

export interface BulkSubmission {
  venue: { id: string; name: string };
  externalId: string;
  number: number | null;
  url: string | null;
  status?: SubmissionStatus | null;
  decision?: string | null;
  reviews?: BulkReview[];
}

export interface BulkPaperRow {
  /** Its public identifier (`arxiv:…`), and its path on the site; `null` for a paper with no identifier yet. */
  identifier: string | null;
  address: string | null;
  title: string;
  year: number | null;
  submissions?: BulkSubmission[];
}

/**
 * One chunk of a scope's papers, rolled up, in a stable order (by page id), after the cursor `after`: each with its
 * submissions (`submissions`), their statuses and decisions (`status`), and each review's score vector (`scores`).
 * `next` is the cursor for the chunk after (the last paper's page id), `null` at the end. Every one of a paper's submissions is listed, not only those to the scope's venues, so a plugin sees a paper
 * rejected at one venue and accepted at the next.
 */
export async function scopePaperChunk(
  scopeId: string,
  options: { after?: string | null; limit: number; fields: readonly PaperField[] },
  database: Database = getDb(),
): Promise<{ rows: BulkPaperRow[]; next: string | null }> {
  const { after, limit, fields } = options;
  const { rows: ids } = await database.execute<{ paper_id: string; title: string; year: number | null }>(sql`
    select m.paper_id, p.title, p.year
      from (select distinct paper_id from page_members where scope_page_id in (${scopePagesOf(scopeId)})
             ${after ? sql`and paper_id > ${after}::uuid` : sql``}) m
      join papers p on p.id = m.paper_id
     order by m.paper_id
     limit ${limit}
  `);
  if (ids.length === 0) return { rows: [], next: null };
  const summaries = await pageSummaries(
    ids.map((r) => r.paper_id),
    database,
  );
  const wantSubmissions = fields.length > 0;
  const byPaper = new Map<string, BulkSubmission[]>();
  if (wantSubmissions) {
    const subs = await database
      .select({ s: submissions, venueName: venues.name, forms: venues.forms })
      .from(submissions)
      .innerJoin(venues, eq(venues.id, submissions.venueId))
      .where(
        inArray(
          submissions.paperId,
          ids.map((r) => r.paper_id),
        ),
      )
      .orderBy(asc(submissions.venueId));
    const notes =
      fields.includes('scores') && subs.length > 0
        ? await database
            .select()
            .from(submissionNotes)
            .where(
              and(
                inArray(
                  submissionNotes.submissionId,
                  subs.map((r) => r.s.id),
                ),
                eq(submissionNotes.kind, 'review'),
              ),
            )
            .orderBy(asc(submissionNotes.createdAt))
        : [];
    const notesOf = new Map<string, typeof notes>();
    for (const note of notes) notesOf.set(note.submissionId, [...(notesOf.get(note.submissionId) ?? []), note]);
    for (const { s, venueName, forms } of subs) {
      const item: BulkSubmission = {
        venue: { id: s.venueId, name: venueName },
        externalId: s.externalId,
        number: s.number,
        url: s.url,
      };
      if (fields.includes('status')) {
        item.status = s.status;
        item.decision = s.decision;
      }
      if (fields.includes('scores')) {
        const reviews = notesOf.get(s.id) ?? [];
        const keys = scoreFieldsOf(forms ?? {}, [...new Set(reviews.map((n) => n.invitation))]).map((f) => f.key);
        item.reviews = reviews.map((n) => ({
          id: n.externalId,
          signature: n.signature,
          scores: Object.fromEntries(
            keys.flatMap((key) => {
              const score = scoreOf(n.content[key]);
              return score === null ? [] : [[key, score]];
            }),
          ),
          url: n.url,
          license: n.license,
        }));
      }
      byPaper.set(s.paperId, [...(byPaper.get(s.paperId) ?? []), item]);
    }
  }
  const rows = ids.map((r) => ({
    identifier: summaries.get(r.paper_id)?.identifier ?? null,
    address: summaries.get(r.paper_id)?.address ?? null,
    title: r.title,
    year: r.year,
    ...(wantSubmissions ? { submissions: byPaper.get(r.paper_id) ?? [] } : {}),
  }));
  return { rows, next: ids.length === limit ? ids[ids.length - 1].paper_id : null };
}
