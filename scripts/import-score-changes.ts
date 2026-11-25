import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { encodeReviewFile, noteFilePath, parseReviewFile, submissionDir } from '@/lib/review-files';
import { type ScoreRecord, scoreChangesFromHistory } from '@/lib/score-history';
import { botActor, OPENREVIEW_BOT } from '@/server/bots';
import { IMPORT_RATE_LIMIT } from '@/server/import-reviews';
import { commitPage, type FileChange } from '@/server/pages/commit';
import { readCommit, readFolder, readHead, readText } from '@/server/pages/repo';

/**
 * Brings the score history the OpenReview scraper kept (its corpus's `review_scores`, which acceptodds shows as each
 * review's `(+1)`) into the reviews' files here, as their `scoreChanges`: one commit per paper, by the `openreview` bot.
 * Safe to run again: a paper whose files already say so commits nothing. Imports after it keep the history up
 * (`import-reviews.ts`).
 *
 *   npm run reviews:score-history -- <corpus.sqlite> [--dry-run]
 */

const corpusPath = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!corpusPath) throw new Error('usage: import-score-changes.ts <corpus.sqlite> [--dry-run]');

/** Papers committed at once, each to its own page. */
const CONCURRENCY = 8;

/** Each review's records, oldest first, for the reviews the corpus saw change. */
function readHistory(path: string): Map<string, ScoreRecord[]> {
  const corpus = new DatabaseSync(path, { readOnly: true });
  const rows = corpus
    .prepare(
      `select id, scores, seen_at from review_scores
        where id in (select id from review_scores group by id having count(*) > 1)
        order by id, seen_at`,
    )
    .all() as { id: string; scores: string; seen_at: string }[];
  corpus.close();
  const history = new Map<string, ScoreRecord[]>();
  for (const row of rows) {
    const list = history.get(row.id) ?? [];
    list.push({ at: row.seen_at, scores: JSON.parse(row.scores) });
    history.set(row.id, list);
  }
  return history;
}

interface Target {
  paperId: string;
  submission: string;
  url: string | null;
  notes: string[];
}

/** The papers whose reviews the history names, with the submissions and notes to look at in each. */
async function targets(ids: string[]): Promise<Map<string, Target[]>> {
  const { rows } = await getDb().execute<{ paper_id: string; submission: string; url: string | null; notes: string[] }>(
    sql`select s.paper_id, s.external_id as submission, s.url, array_agg(n.external_id) as notes
          from submission_notes n
          join submissions s on s.id = n.submission_id
         where n.kind = 'review' and starts_with(s.venue_id, 'openreview:')
           and n.external_id = any(${sql.param(ids)}::text[])
         group by s.paper_id, s.external_id, s.url`,
  );
  const byPaper = new Map<string, Target[]>();
  for (const row of rows) {
    const list = byPaper.get(row.paper_id) ?? [];
    list.push({ paperId: row.paper_id, submission: row.submission, url: row.url, notes: row.notes });
    byPaper.set(row.paper_id, list);
  }
  return byPaper;
}

async function main() {
  const history = readHistory(corpusPath);
  console.log(`${history.size} reviews with more than one record in ${corpusPath}`);
  const papers = await targets([...history.keys()]);
  console.log(`${papers.size} papers have them`);
  const database = getDb();
  const actor = await botActor(OPENREVIEW_BOT, database);
  const now = new Date().toISOString();
  const totals = { committed: 0, unchanged: 0, failed: 0, notes: 0 };

  async function one(paperId: string, subs: Target[]): Promise<void> {
    const head = await readHead(database, paperId);
    if (!head) return;
    const tree = (await readCommit(database, paperId, head)).tree;
    const changes: FileChange[] = [];
    for (const sub of subs) {
      const held = await readFolder(database, paperId, tree, submissionDir('openreview', sub.submission));
      for (const id of sub.notes) {
        const path = noteFilePath('openreview', sub.submission, id);
        const blob = held.get(path);
        if (!blob) continue;
        const text = (await readText(database, paperId, blob)) ?? '';
        const parsed = parseReviewFile('note', text);
        if (!('file' in parsed)) continue;
        const { scoreChanges: existing = [], ...file } = parsed.file;
        const scoreChanges = scoreChangesFromHistory(history.get(id) ?? [], file.content, existing, now);
        const next = encodeReviewFile({ ...file, ...(scoreChanges.length > 0 ? { scoreChanges } : {}) });
        if (next !== text) changes.push({ path, content: next });
      }
    }
    if (changes.length === 0) {
      totals.unchanged += 1;
      return;
    }
    totals.notes += changes.length;
    if (dryRun) {
      totals.committed += 1;
      return;
    }
    const result = await commitPage(
      paperId,
      head,
      actor,
      changes,
      `Record how ${changes.length} review${changes.length === 1 ? "'s" : "s'"} scores moved since first posted`,
      { database, rateLimit: IMPORT_RATE_LIMIT, evidence: subs.flatMap((sub) => (sub.url ? [sub.url] : [])) },
    );
    if (result.status === 'committed') totals.committed += 1;
    else totals.unchanged += 1;
  }

  const queue = [...papers.entries()];
  let done = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          await one(item[0], item[1]);
        } catch (e) {
          totals.failed += 1;
          console.error(`${item[0]}: ${e instanceof Error ? e.message : e}`);
        }
        done += 1;
        if (done % 500 === 0) console.log(`${done}/${papers.size}`, totals);
      }
    }),
  );
  console.log(dryRun ? 'dry run:' : 'done:', totals);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
