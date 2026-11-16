import { and, eq, notInArray, sql } from 'drizzle-orm';
import type { Database } from '@/db';
import { submissionNotes, submissions, venues } from '@/db/schema';
import {
  type FormsFile,
  type NoteFile,
  parseReviewFile,
  parseReviewPath,
  REVIEWS_DIR,
  type SubmissionFile,
} from '@/lib/review-files';
import type { Consumer } from './consumers/types';
import { pageRepo } from './git/repo';
import { readCommit, readFolder } from './pages/repo';

/**
 * The review projection (DESIGN.md §4.9): the `reviews` outbox consumer, which brings a page's rows in
 * `submissions` and `submission_notes`, and the forms of their `venues`, up to a commit, from the files a bot
 * wrote under `reviews/<source>/<submission>/` (`lib/review-files.ts`). The Submissions panel reads only these
 * tables (`submissions.ts`), so it shows what the repo says once the worker has caught up.
 *
 * A venue's id is `<source>:<the source's venue id>` (`openreview:ICLR.cc/2027/Conference`). Its forms are
 * those of the last page projected that has a `forms.json`: an import writes the same forms into every
 * submission of a venue. `fetched_at` is when the submission's folder last changed (its newest commit up to
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
  forms?: string;
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
    else if (parsed.kind === 'forms') folder.forms = blob;
    else folder.notes.push(blob);
  }
  return folders;
}

interface Projected {
  venueId: string;
  submission: SubmissionFile;
  forms: FormsFile | null;
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
      join page_revisions r on r.paper_id = ${paperId}
       and r.seq <= coalesce((select seq from page_revisions
                               where paper_id = ${paperId} and oid = decode(${head}, 'hex')), 2147483647)
       and exists (select 1 from unnest(r.paths) as p(path) where starts_with(p.path, d.dir || '/'))
     group by d.dir
  `);
  return new Map(rows.map((row) => [row.dir, new Date(row.at)]));
}

/** Brings `paperId`'s submissions, notes and their venues' forms up to commit `head`. */
export async function projectReviews(database: Database, paperId: string, head: string): Promise<ProjectReport> {
  const commit = await readCommit(database, paperId, head);
  const folders = reviewFolders(await readFolder(database, paperId, commit.tree, REVIEWS_DIR));
  const times = await changedAt(database, paperId, head, [...folders.keys()]);
  const fallback = commit.at;
  // Every review file in one read.
  const blobs = [...folders.values()].flatMap((f) =>
    [f.submission, f.forms, ...f.notes].filter((b) => b !== undefined),
  );
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
    let forms: FormsFile | null = null;
    if (folder.forms) {
      const parsed = parseReviewFile('forms', textOf(folder.forms) ?? '');
      if ('file' in parsed) forms = parsed.file;
    }
    const notes: NoteFile[] = [];
    for (const blob of folder.notes) {
      const parsed = parseReviewFile('note', textOf(blob) ?? '');
      if ('file' in parsed) notes.push(parsed.file);
    }
    projected.push({
      venueId: `${folder.source}:${submission.file.venue.id}`,
      submission: submission.file,
      forms,
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
      const { venue } = item.submission;
      await tx
        .insert(venues)
        .values({ id: item.venueId, name: venue.name, url: venue.url, forms: item.forms?.forms ?? {} })
        .onConflictDoUpdate({
          target: venues.id,
          set: {
            name: venue.name,
            url: venue.url,
            ...(item.forms ? { forms: item.forms.forms } : {}),
          },
        });
      const s = item.submission;
      const [row] = await tx
        .insert(submissions)
        .values({
          paperId,
          venueId: item.venueId,
          externalId: s.id,
          number: s.number,
          status: s.status,
          decision: s.decision,
          url: s.url,
          fetchedAt: item.changedAt,
        })
        .onConflictDoUpdate({
          target: [submissions.venueId, submissions.externalId],
          set: {
            paperId,
            number: s.number,
            status: s.status,
            decision: s.decision,
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
    return report;
  });
}

export const reviewsConsumer: Consumer = {
  name: 'reviews',
  async handle(paperId, head, { database }) {
    await projectReviews(database, paperId, head);
  },
  async reset({ database }) {
    await database.execute(sql`truncate submission_notes, submissions`);
  },
};
