import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { paperIdentifiers, papers } from '@/db/schema';
import { KINDS } from '@/lib/kinds';
import { encodePaperFile, paperFileOf, parsePaperFile } from '@/lib/paper-file';
import { IMPORT_RATE_LIMIT } from './import-reviews';
import { commitPage, SYSTEM_ACTOR } from './pages/commit';
import { readCommit, readFiles, readHead, readText } from './pages/repo';
import { CC0 } from './paper-sources/types';
import { UNDER_REVIEW } from './under-review';

export interface Submission {
  /** The OpenReview id. */
  id: string;
  title: string;
  abstract: string | null;
  /**
   * Only for a venue whose review has ended. Left out, the paper stays anonymous. Given for one already here with no
   * authors, they are added once it is no longer under review (it was withdrawn, or rejected): `nameAuthors`.
   */
  authors?: string[];
}

const CHUNK = 500;
/** OpenReview holds test notes and placeholders; a real abstract is longer than this. */
const ABSTRACT_MIN = 50;

/**
 * Add conference submissions under their OpenReview ids. Authors stay empty unless given: the source
 * has none while a paper is under review, and none must be added then. Safe to run again: one already
 * imported is left as it is, except that one with no authors is given them once its review has ended
 * (`nameAuthors`). Returns how many were added, and how many were named.
 */
export async function importSubmissions(
  submissions: Iterable<Submission>,
  database: Database = getDb(),
): Promise<{ added: number; named: number }> {
  const usable = [...submissions].filter((s) => s.title.trim() && (s.abstract?.trim().length ?? 0) >= ABSTRACT_MIN);
  let added = 0;
  const known = new Map<string, string[]>();
  for (let start = 0; start < usable.length; start += CHUNK) {
    const chunk = usable.slice(start, start + CHUNK);
    await database.transaction(async (tx) => {
      const found = await tx
        .select({ value: paperIdentifiers.value })
        .from(paperIdentifiers)
        .where(
          inArray(
            paperIdentifiers.value,
            chunk.map((s) => s.id),
          ),
        );
      const seen = new Set(found.map((k) => k.value));
      for (const s of chunk) if (seen.has(s.id) && s.authors?.length) known.set(s.id, s.authors);
      const fresh = chunk.filter((s) => !seen.has(s.id)).map((s) => ({ ...s, paperId: randomUUID() }));
      if (fresh.length === 0) return;
      await tx.insert(papers).values(
        fresh.map((s) => ({
          id: s.paperId,
          title: s.title.trim(),
          abstract: s.abstract?.trim(),
          authors: s.authors ?? [],
          source: 'openreview' as const,
          // OpenReview's terms define title, authors and abstract as metadata, dedicated to CC0.
          metadataLicense: CC0,
          abstractLicense: CC0,
        })),
      );
      await tx
        .insert(paperIdentifiers)
        .values(fresh.map((s) => ({ scheme: 'openreview' as const, value: s.id, paperId: s.paperId })));
      added += fresh.length;
    });
  }
  let named = 0;
  for (const [id, authors] of known) if (await nameAuthors(id, authors, database)) named += 1;
  return { added, named };
}

/**
 * Names the authors of a paper imported while it was anonymous, once its review has ended: as the system, in its
 * `paper.json`. Nothing happens while any submission of it is still under review, or if it already names authors
 * (someone may have written them, and they are the paper's now). Whether it named them.
 */
export async function nameAuthors(
  openreview: string,
  authors: string[],
  database: Database = getDb(),
): Promise<boolean> {
  const [row] = await database
    .select({ paper: papers })
    .from(papers)
    .innerJoin(paperIdentifiers, eq(paperIdentifiers.paperId, papers.id))
    .where(
      and(
        eq(paperIdentifiers.scheme, 'openreview'),
        eq(paperIdentifiers.value, openreview),
        sql`jsonb_array_length(${papers.authors}) = 0`,
        sql`not ${UNDER_REVIEW(sql`${papers.id}`)}`,
      ),
    );
  if (!row) return false;
  const paper = row.paper;
  const file = paperFileOf({ ...paper, authors });
  if (file.authors.length === 0) return false;
  const head = await readHead(database, paper.id);
  if (!head) {
    // No repo yet: its first commit writes paper.json from the row.
    await database.update(papers).set({ authors: file.authors }).where(eq(papers.id, paper.id));
    return true;
  }
  const files = await readFiles(database, paper.id, (await readCommit(database, paper.id, head)).tree);
  const current = parsePaperFile(await readText(database, paper.id, files.get(KINDS.paper.kindFile)));
  if (current && current.authors.length > 0) return false;
  const result = await commitPage(
    paper.id,
    head,
    SYSTEM_ACTOR,
    [{ path: KINDS.paper.kindFile, content: encodePaperFile(current ? { ...current, authors: file.authors } : file) }],
    'Name the authors, now that its review has ended',
    { database, rateLimit: IMPORT_RATE_LIMIT },
  );
  return result.status === 'committed';
}
