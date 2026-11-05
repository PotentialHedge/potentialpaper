import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { paperIdentifiers, papers } from '@/db/schema';

export interface Submission {
  /** The OpenReview id. */
  id: string;
  title: string;
  abstract: string | null;
  /** Only for a venue whose review has ended. Left out, the paper stays anonymous. */
  authors?: string[];
  /** Overrides the venue's name, for a paper it didn't accept. */
  venue?: string;
}

const CHUNK = 500;
/** OpenReview holds test notes and placeholders; a real abstract is longer than this. */
const ABSTRACT_MIN = 50;

/**
 * Add conference submissions under their OpenReview ids. Authors stay empty unless given: the source
 * has none while a paper is under review, and none must be added then. Safe to run again: one already
 * imported is left as it is. Returns how many were added.
 */
export async function importSubmissions(
  submissions: Iterable<Submission>,
  venue: { name: string; year: number },
  database: Database = getDb(),
): Promise<number> {
  const usable = [...submissions].filter((s) => s.title.trim() && (s.abstract?.trim().length ?? 0) >= ABSTRACT_MIN);
  let added = 0;
  for (let start = 0; start < usable.length; start += CHUNK) {
    const chunk = usable.slice(start, start + CHUNK);
    await database.transaction(async (tx) => {
      const known = await tx
        .select({ value: paperIdentifiers.value })
        .from(paperIdentifiers)
        .where(
          inArray(
            paperIdentifiers.value,
            chunk.map((s) => s.id),
          ),
        );
      const seen = new Set(known.map((k) => k.value));
      const fresh = chunk.filter((s) => !seen.has(s.id)).map((s) => ({ ...s, paperId: randomUUID() }));
      if (fresh.length === 0) return;
      await tx.insert(papers).values(
        fresh.map((s) => ({
          id: s.paperId,
          title: s.title.trim(),
          abstract: s.abstract?.trim(),
          authors: s.authors ?? [],
          year: venue.year,
          venue: s.venue ?? venue.name,
        })),
      );
      await tx
        .insert(paperIdentifiers)
        .values(fresh.map((s) => ({ scheme: 'openreview' as const, value: s.id, paperId: s.paperId })));
      added += fresh.length;
    });
  }
  return added;
}
