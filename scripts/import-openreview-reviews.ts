import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { getPool } from '@/db';
import { IMPORT_RATE_LIMIT, importReviews, type ImportResult, type SubmissionInput } from '@/server/import-reviews';
import { syncVenuePages } from '@/server/venue-pages';
import { openReviewForms } from '@/server/venue-sources/iclr-forms';
import {
  forumUrl,
  OPENREVIEW_NOTE_LICENSE,
  parseReply,
  submissionStatus,
  venueUrl,
  type OpenReviewNote,
  type ParsedNote,
} from '@/server/venue-sources/openreview';

/**
 * Imports a venue's public OpenReview notes (reviews, meta-reviews, decisions, comments) from a scrape, as the
 * `openreview` bot's files in each paper's repo (`server/import-reviews.ts`):
 * `npm run papers:import-reviews -- data/iclr2027.sqlite ICLR.cc/2027/Conference "ICLR 2027" [--from <forum id>]
 * [--concurrency 4]`
 *
 * The scrape has `submissions(id, number, venueid)` and `replies(forum, raw)` with each reply's API v2 note
 * as JSON. Submissions attach to papers by their OpenReview id, so import the papers first
 * (`papers:import-iclr`). Re-running commits only what changed, so a run that stopped is resumed by running it
 * again (`--from` skips the forums before one, in id order, to get there sooner). The worker's `reviews`
 * consumer then projects the files into the tables the page reads. At the end the `venues` bot makes the venue's
 * series and edition pages (`/v/iclr`, `/v/iclr/2027`), if they aren't there yet.
 */

const BATCH = 1_000;

interface SubmissionRow {
  id: string;
  number: number | null;
  venueid: string | null;
  /** A JSON array, in scrapes that kept the submission's keywords. */
  keywords?: string | null;
}

function keywordsOf(row: SubmissionRow): string[] {
  try {
    const value: unknown = JSON.parse(row.keywords ?? '[]');
    return Array.isArray(value) ? value.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
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
    keywords: keywordsOf(row),
    url: forumUrl(row.id),
    notes: notes.map((note) => {
      const input: Partial<ParsedNote> = { ...note };
      delete input.forum;
      return input as Omit<ParsedNote, 'forum'>;
    }),
  };
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const from = flag(args, '--from') ?? '';
  const concurrency = Number(flag(args, '--concurrency') ?? '4');
  const [path, group, name] = args;
  if (!path || !group || !name || !Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      'usage: papers:import-reviews <path to sqlite> <OpenReview venue group> <venue name> [--from <forum>] [--concurrency n]',
    );
  }
  const sqlite = new DatabaseSync(path, { readOnly: true });
  const venue = {
    source: 'openreview',
    id: group,
    name,
    url: venueUrl(group),
    forms: openReviewForms(group),
    license: OPENREVIEW_NOTE_LICENSE,
  };
  // Older scrapes have no keywords column.
  const columns = (sqlite.prepare(`select name from pragma_table_info('submissions')`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  const keywords = columns.includes('keywords') ? ', keywords' : '';
  const rows = sqlite
    .prepare(`select id, number, venueid${keywords} from submissions where id >= ? order by id`)
    .all(from) as unknown as SubmissionRow[];
  const started = Date.now();
  const replies = sqlite.prepare(`select raw from replies where forum >= ? and forum <= ? order by forum`);
  const totals = { submissions: 0, notes: 0, skipped: 0, committed: 0, unchanged: 0, private: 0 };
  const failed: ImportResult['failed'] = [];
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
      { rateLimit: IMPORT_RATE_LIMIT, concurrency },
    );
    for (const key of ['submissions', 'notes', 'skipped', 'committed', 'unchanged'] as const) {
      totals[key] += result[key];
    }
    for (const failure of result.failed) console.log(`failed ${failure.externalId}: ${failure.error}`);
    failed.push(...result.failed);
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
      `${start + batch.length} / ${rows.length} (through ${batch.at(-1)!.id}, ${seconds}s): ` +
        `${totals.committed} committed, ${totals.unchanged} unchanged, ${totals.skipped} skipped, ${failed.length} failed`,
    );
  }
  console.log(
    `${totals.submissions} submissions with ${totals.notes} notes (${totals.committed} committed, ` +
      `${totals.unchanged} unchanged); ${totals.skipped} without a paper here, ${failed.length} refused, ` +
      `${totals.private} notes not public`,
  );
  sqlite.close();
  // The venue's pages, series and edition, as the `venues` bot makes them (`server/venue-pages.ts`).
  const pages = await syncVenuePages({ venues: [{ id: `${venue.source}:${venue.id}`, name: venue.name }] });
  console.log(
    pages.written.length > 0
      ? `venue pages written: ${pages.written.join(', ')}`
      : pages.skipped.length > 0
        ? `no venue page for ${pages.skipped.join(', ')} (only a conference's main edition has one yet)`
        : 'venue pages up to date',
  );
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
