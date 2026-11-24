import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { submissionNotes, submissions, venues } from '@/db/schema';
import {
  type NoteFile,
  parseReviewFile,
  parseReviewPath,
  REVIEWS_DIR,
  reviewsKey,
  type SubmissionFile,
} from '@/lib/review-files';
import { parseVersionFile, type VersionSubmission } from '@/lib/versions';
import type { Consumer } from './consumers/types';
import { pageRepo } from './git/repo';
import { readCommit, readFolder, readText } from './pages/repo';
import { versionIdOf, VERSIONS_DIR } from './pages/rules';
import { refreshPaperRating } from './paper-ratings';
import { markPaperScopes } from './scope-stats';

/**
 * The review projection (DESIGN.md §4.9): the `reviews` outbox consumer, which brings a page's rows in
 * `submissions` and `submission_notes` up to a commit, from the files a bot
 * wrote under `reviews/<source>/<submission>/` (`lib/review-files.ts`), with each one's status and decision from
 * its entry in the version it is of (`lib/versions.ts`, the one place a decision is kept). The Submissions panel reads only these
 * tables (`submissions.ts`), so it shows what the repo says once the worker has caught up.
 *
 * A venue's id is `<source>:<the source's venue id>` (`openreview:ICLR.cc/2027/Conference`). Its `venues` row, name
 * and forms, is its venue page's projection (`venue-projection.ts`); this only makes a bare row, named by its id, where
 * there is none yet, which a submission's row needs to refer to. `fetched_at` is when the submission's folder last changed (its newest commit up to
 * this head), since an import that finds nothing new commits nothing.
 *
 * Rows of a submission whose folder is gone go, so a bot taking one down removes it. Re-running at the same head
 * writes the same rows, as a consumer must. `consumers:rebuild -- reviews` empties the submissions (venues
 * stay) and replays every page.
 */

interface Folder {
  source: string;
  dir: string;
  submission?: string;
  notes: string[];
}

/** The page's review folders at `head`, by `reviews/<source>/<submission>`, with each file's blob id. */
function reviewFolders(files: ReadonlyMap<string, string>): Map<string, Folder> {
  const folders = new Map<string, Folder>();
  for (const [path, blob] of files) {
    const parsed = parseReviewPath(path);
    if (!parsed) continue;
    const dir = `${REVIEWS_DIR}/${parsed.source}/${parsed.submission}`;
    let folder = folders.get(dir);
    if (!folder) {
      folder = { source: parsed.source, dir, notes: [] };
      folders.set(dir, folder);
    }
    if (parsed.kind === 'submission') folder.submission = blob;
    else folder.notes.push(blob);
  }
  return folders;
}

/**
 * Each imported submission's entry in the version it is of, by its `reviews` (`<source>/<submission>`): where its
 * status and decision are kept.
 */
async function versionEntries(
  database: Database,
  paperId: string,
  tree: string,
): Promise<Map<string, VersionSubmission>> {
  const entries = new Map<string, VersionSubmission>();
  for (const [path, blob] of await readFolder(database, paperId, tree, VERSIONS_DIR)) {
    const id = versionIdOf(path);
    if (!id) continue;
    const parsed = parseVersionFile(id, (await readText(database, paperId, blob)) ?? '');
    if (!('version' in parsed)) continue;
    for (const entry of parsed.version.submissions ?? []) if (entry.reviews) entries.set(entry.reviews, entry);
  }
  return entries;
}

interface Projected {
  venueId: string;
  submission: SubmissionFile;
  /** Its entry in its version, which says what the venue decided. */
  entry: VersionSubmission | null;
  notes: NoteFile[];
  changedAt: Date;
}

export interface ProjectReport {
  submissions: number;
  notes: number;
  /** Rows of submissions whose folder is gone. */
  removed: number;
}

/** When each folder last changed, up to `head`: the newest revision that touched a path under it. */
async function changedAt(
  database: Database,
  paperId: string,
  head: string,
  dirs: string[],
): Promise<Map<string, Date>> {
  if (dirs.length === 0) return new Map();
  const { rows } = await database.execute<{ dir: string; at: Date | string }>(sql`
    select d.dir, max(r.at) as at
      from unnest(${sql.param(dirs)}::text[]) as d(dir)
      join page_revisions r on r.page_id = ${paperId}
       and r.seq <= coalesce((select seq from page_revisions
                               where page_id = ${paperId} and oid = decode(${head}, 'hex')), 2147483647)
       and exists (select 1 from unnest(r.paths) as p(path) where starts_with(p.path, d.dir || '/'))
     group by d.dir
  `);
  return new Map(rows.map((row) => [row.dir, new Date(row.at)]));
}

/** Brings `paperId`'s submissions and notes up to commit `head`. */
export async function projectReviews(database: Database, paperId: string, head: string): Promise<ProjectReport> {
  const commit = await readCommit(database, paperId, head);
  const folders = reviewFolders(await readFolder(database, paperId, commit.tree, REVIEWS_DIR));
  const times = await changedAt(database, paperId, head, [...folders.keys()]);
  const entries = folders.size > 0 ? await versionEntries(database, paperId, commit.tree) : new Map();
  const fallback = commit.at;
  // Every review file in one read.
  const blobs = [...folders.values()].flatMap((f) => [f.submission, ...f.notes].filter((b) => b !== undefined));
  const bodies = blobs.length > 0 ? await pageRepo(database, paperId).read(blobs) : new Map();
  const textOf = (blob: string | undefined) => (blob ? (bodies.get(blob)?.body.toString('utf8') ?? null) : null);

  const projected: Projected[] = [];
  for (const folder of folders.values()) {
    // The commit path checks every review file (`check.ts`), so a bad one here is from a schema this code no
    // longer reads; its folder is left out rather than stopping the consumer.
    const text = textOf(folder.submission);
    if (text === null) continue;
    const submission = parseReviewFile('submission', text);
    if (!('file' in submission)) continue;
    const notes: NoteFile[] = [];
    for (const blob of folder.notes) {
      const parsed = parseReviewFile('note', textOf(blob) ?? '');
      if ('file' in parsed) notes.push(parsed.file);
    }
    projected.push({
      venueId: `${folder.source}:${submission.file.venue.id}`,
      submission: submission.file,
      entry: entries.get(reviewsKey(folder.source, submission.file.id)) ?? null,
      notes,
      changedAt: times.get(folder.dir) ?? fallback,
    });
  }

  return database.transaction(async (tx) => {
    // One projection at a time per page, as the search index does.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`reviews:${paperId}`}, 0))`);
    const report: ProjectReport = { submissions: 0, notes: 0, removed: 0 };
    const kept: string[] = [];
    for (const item of projected) {
      await tx.insert(venues).values({ id: item.venueId, name: item.venueId }).onConflictDoNothing();
      const s = item.submission;
      const status = item.entry?.status ?? null;
      const decision = item.entry?.decision ?? null;
      const [row] = await tx
        .insert(submissions)
        .values({
          paperId,
          venueId: item.venueId,
          externalId: s.id,
          number: s.number,
          status,
          decision,
          keywords: s.keywords ?? [],
          primaryArea: s.primaryArea ?? null,
          tldr: s.tldr ?? null,
          url: s.url,
          fetchedAt: item.changedAt,
        })
        .onConflictDoUpdate({
          target: [submissions.venueId, submissions.externalId],
          set: {
            paperId,
            number: s.number,
            status,
            decision,
            keywords: s.keywords ?? [],
            primaryArea: s.primaryArea ?? null,
            tldr: s.tldr ?? null,
            url: s.url,
            fetchedAt: item.changedAt,
          },
        })
        .returning({ id: submissions.id });
      kept.push(row.id);
      await tx.delete(submissionNotes).where(eq(submissionNotes.submissionId, row.id));
      // A note named twice (two files spelling one id) is kept once.
      const notes = [...new Map(item.notes.map((note) => [note.id, note])).values()];
      for (let at = 0; at < notes.length; at += 200) {
        await tx.insert(submissionNotes).values(
          notes.slice(at, at + 200).map((note) => ({
            submissionId: row.id,
            externalId: note.id,
            replyTo: note.replyTo,
            kind: note.kind,
            invitation: note.invitation,
            signature: note.signature,
            content: note.content,
            license: note.license,
            url: note.url,
            createdAt: new Date(note.createdAt),
            modifiedAt: note.modifiedAt ? new Date(note.modifiedAt) : null,
          })),
        );
      }
      report.submissions += 1;
      report.notes += notes.length;
    }
    const gone = await tx
      .delete(submissions)
      .where(
        kept.length > 0
          ? and(eq(submissions.paperId, paperId), notInArray(submissions.id, kept))
          : eq(submissions.paperId, paperId),
      )
      .returning({ id: submissions.id });
    report.removed = gone.length;
    // The paper's scopes' score statistics are due again (`scope-stats.ts`).
    await markPaperScopes(tx, paperId);
    // And its rating, for the home list's rating sort (`paper-ratings.ts`).
    await refreshPaperRating(tx, paperId);
    return report;
  });
}

export const reviewsConsumer: Consumer = {
  name: 'reviews',
  // Submissions and their reviews are a paper's files.
  kinds: ['paper'],
  async handle(paperId, head, { database }) {
    await projectReviews(database, paperId, head);
  },
  async reset({ database }) {
    await database.execute(sql`truncate submission_notes, submissions`);
  },
};
