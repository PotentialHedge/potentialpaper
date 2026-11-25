import { asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { papers, submissionNotes, submissions, venues } from '@/db/schema';
import type { Submission } from '@/lib/submissions';

/**
 * A paper's submissions with their notes, the latest first, by when its first note was written. Includes
 * those of duplicates merged into it, whose rows still name the duplicate.
 */
export async function submissionsOf(paperId: string, database: Database = getDb()): Promise<Submission[]> {
  // The paper's and those merged into it, as one list: `paper_id = $1 or paper_id in (…)` scanned every submission.
  const rows = await database
    .select({ submission: submissions, venue: venues })
    .from(submissions)
    .innerJoin(venues, eq(venues.id, submissions.venueId))
    .where(
      sql`${submissions.paperId} in (select ${paperId}::uuid union all
                                      select ${papers.id} from ${papers} where ${papers.mergedInto} = ${paperId})`,
    )
    .orderBy(asc(venues.name));
  if (rows.length === 0) return [];
  const notes = await database
    .select()
    .from(submissionNotes)
    .where(
      inArray(
        submissionNotes.submissionId,
        rows.map((row) => row.submission.id),
      ),
    )
    .orderBy(asc(submissionNotes.createdAt));
  const found: Submission[] = rows.map(({ submission, venue }) => ({
    venue: { id: venue.id, name: venue.name, url: venue.url, forms: venue.forms },
    externalId: submission.externalId,
    number: submission.number,
    status: submission.status,
    decision: submission.decision,
    keywords: submission.keywords,
    primaryArea: submission.primaryArea,
    tldr: submission.tldr,
    url: submission.url,
    fetchedAt: submission.fetchedAt,
    notes: notes
      .filter((note) => note.submissionId === submission.id)
      .map(({ externalId, replyTo, kind, invitation, signature, content, license, url, createdAt, scoreChanges }) => ({
        externalId,
        replyTo,
        kind,
        invitation,
        signature,
        content,
        license,
        url,
        createdAt,
        scoreChanges,
      })),
  }));
  const started = (s: Submission) => s.notes[0]?.createdAt.getTime() ?? s.fetchedAt.getTime();
  return found.sort((a, b) => started(b) - started(a));
}
