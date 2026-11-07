import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { getPool } from '@/db';
import { importReviews, type SubmissionInput } from '@/server/import-reviews';
import { openReviewForms } from '@/server/venue-sources/iclr-forms';
import {
  forumUrl,
  parseReply,
  submissionStatus,
  venueUrl,
  type OpenReviewNote,
  type ParsedNote,
} from '@/server/venue-sources/openreview';

/**
 * Imports a venue's public OpenReview notes (reviews, meta-reviews, decisions, comments) from a scrape:
 * `npm run papers:import-reviews -- data/iclr2027.sqlite ICLR.cc/2027/Conference "ICLR 2027"`
 *
 * The scrape has `submissions(id, number, venueid)`, `replies(forum, raw)` with each reply's API v2 note
 * as JSON, and optionally `meta(key, value)` with `reviews_fetched_at`. Submissions attach to papers by
 * their OpenReview id, so import the papers first (`papers:import-iclr`).
 */

const BATCH = 1_000;

interface SubmissionRow {
  id: string;
  number: number | null;
  venueid: string | null;
}

function fetchedAt(sqlite: DatabaseSync): Date {
  try {
    const row = sqlite.prepare(`select value from meta where key = 'reviews_fetched_at'`).get() as
      { value: string } | undefined;
    if (row) return new Date(row.value);
  } catch {
    // No `meta` table: the scrape is taken to be as old as the import.
  }
  return new Date();
}

function toSubmission(row: SubmissionRow, notes: ParsedNote[]): SubmissionInput {
  const decision = notes.find((note) => note.kind === 'decision')?.content.decision;
  const decisionText = typeof decision === 'string' ? decision.trim() : null;
  return {
    externalId: row.id,
    paper: { scheme: 'openreview', value: row.id },
    number: row.number,
    status: submissionStatus(row.venueid, decisionText),
    decision: decisionText,
    url: forumUrl(row.id),
    notes: notes.map((note) => {
      const input: Partial<ParsedNote> = { ...note };
      delete input.forum;
      return input as Omit<ParsedNote, 'forum'>;
    }),
  };
}

async function main() {
  const [path, group, name] = process.argv.slice(2);
  if (!path || !group || !name) {
    throw new Error('usage: papers:import-reviews <path to sqlite> <OpenReview venue group> <venue name>');
  }
  const sqlite = new DatabaseSync(path, { readOnly: true });
  const venue = { id: `openreview:${group}`, name, url: venueUrl(group), forms: openReviewForms(group) };
  const when = fetchedAt(sqlite);
  const rows = sqlite
    .prepare(`select id, number, venueid from submissions order by id`)
    .all() as unknown as SubmissionRow[];
  const replies = sqlite.prepare(`select raw from replies where forum >= ? and forum <= ? order by forum`);
  const totals = { submissions: 0, notes: 0, skipped: 0, private: 0 };
  for (let start = 0; start < rows.length; start += BATCH) {
    const batch = rows.slice(start, start + BATCH);
    const byForum = new Map<string, ParsedNote[]>(batch.map((row) => [row.id, []]));
    for (const { raw } of replies.iterate(batch[0].id, batch.at(-1)!.id) as Iterable<{ raw: string }>) {
      const note = parseReply(JSON.parse(raw) as OpenReviewNote);
      if (!note) totals.private += 1;
      else byForum.get(note.forum)?.push(note);
    }
    const result = await importReviews(
      venue,
      batch.map((row) => toSubmission(row, byForum.get(row.id)!)),
      when,
    );
    totals.submissions += result.submissions;
    totals.notes += result.notes;
    totals.skipped += result.skipped;
    console.log(`${start + batch.length} / ${rows.length}`);
  }
  console.log(
    `imported ${totals.submissions} submissions with ${totals.notes} notes; ` +
      `${totals.skipped} without a paper here, ${totals.private} notes not public`,
  );
  sqlite.close();
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
