import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { paperIdentifiers, submissionNotes, submissions, venues } from '@/db/schema';
import type { PaperId } from '@/lib/paper-ids';
import type { FieldValue, NoteKind, SubmissionStatus, VenueForms } from '@/lib/submissions';

/**
 * Adding a venue's submissions and what it published about them, from any source. A submission is
 * attached to the paper one of its identifiers names; one whose paper we don't have is skipped. Safe to
 * run again: each run replaces a submission's notes with the ones given, so a note the venue took down
 * goes too.
 */

export interface VenueInput {
  id: string;
  name: string;
  url: string | null;
  forms: VenueForms;
}

export interface NoteInput {
  externalId: string;
  replyTo: string | null;
  kind: NoteKind;
  invitation: string;
  signature: string;
  content: Record<string, FieldValue>;
  license: string;
  url: string | null;
  createdAt: Date;
  modifiedAt: Date | null;
}

export interface SubmissionInput {
  externalId: string;
  /** The paper it is, by any of its identifiers. */
  paper: PaperId;
  number: number | null;
  status: SubmissionStatus | null;
  decision: string | null;
  url: string | null;
  notes: NoteInput[];
}

const CHUNK = 200;

export interface ImportResult {
  submissions: number;
  notes: number;
  /** Submissions whose paper we don't have. */
  skipped: number;
}

export async function importReviews(
  venue: VenueInput,
  input: Iterable<SubmissionInput>,
  fetchedAt: Date,
  database: Database = getDb(),
): Promise<ImportResult> {
  await database
    .insert(venues)
    .values(venue)
    .onConflictDoUpdate({ target: venues.id, set: { name: venue.name, url: venue.url, forms: venue.forms } });
  // One row per submission: an upsert can't name the same row twice.
  const all = [...new Map([...input].map((s) => [s.externalId, s])).values()];
  const result: ImportResult = { submissions: 0, notes: 0, skipped: 0 };
  for (let start = 0; start < all.length; start += CHUNK) {
    const chunk = all.slice(start, start + CHUNK);
    await database.transaction(async (tx) => {
      const papers = new Map<string, string>();
      for (const scheme of new Set(chunk.map((s) => s.paper.scheme))) {
        const values = chunk.filter((s) => s.paper.scheme === scheme).map((s) => s.paper.value);
        const rows = await tx
          .select({ value: paperIdentifiers.value, paperId: paperIdentifiers.paperId })
          .from(paperIdentifiers)
          .where(and(eq(paperIdentifiers.scheme, scheme), inArray(paperIdentifiers.value, values)));
        for (const row of rows) papers.set(`${scheme}:${row.value}`, row.paperId);
      }
      const known = chunk.flatMap((s) => {
        const paperId = papers.get(`${s.paper.scheme}:${s.paper.value}`);
        return paperId ? [{ ...s, paperId }] : [];
      });
      result.skipped += chunk.length - known.length;
      if (known.length === 0) return;
      const saved = await tx
        .insert(submissions)
        .values(
          known.map((s) => ({
            paperId: s.paperId,
            venueId: venue.id,
            externalId: s.externalId,
            number: s.number,
            status: s.status,
            decision: s.decision,
            url: s.url,
            fetchedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [submissions.venueId, submissions.externalId],
          set: {
            paperId: sqlExcluded('paper_id'),
            number: sqlExcluded('number'),
            status: sqlExcluded('status'),
            decision: sqlExcluded('decision'),
            url: sqlExcluded('url'),
            fetchedAt: sqlExcluded('fetched_at'),
          },
        })
        .returning({ id: submissions.id, externalId: submissions.externalId });
      const ids = new Map(saved.map((row) => [row.externalId, row.id]));
      await tx.delete(submissionNotes).where(inArray(submissionNotes.submissionId, [...ids.values()]));
      const notes = known.flatMap((s) => {
        // A source can list a note twice, as a scan and a lookup both return it.
        const unique = new Map(s.notes.map((note) => [note.externalId, note]));
        return [...unique.values()].map((note) => ({ ...note, submissionId: ids.get(s.externalId)! }));
      });
      for (let at = 0; at < notes.length; at += CHUNK) {
        await tx.insert(submissionNotes).values(notes.slice(at, at + CHUNK));
      }
      result.submissions += known.length;
      result.notes += notes.length;
    });
  }
  return result;
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}
