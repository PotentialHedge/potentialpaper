import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { pageObjects } from '@/db/schema';
import type { GitObjectType } from '../pages/git-objects';
import { readHead, type Reader, toBytes } from '../pages/repo';

/**
 * What the git protocols need of a repository, and nothing about where it lives. Each page's repo is its rows
 * in `page_objects` and `page_refs` (DESIGN.md §4.1); tests can hand in a map.
 */
export interface GitRepo {
  /** `refs/heads/main`, the only ref, or `null` when the repo has no commit yet. */
  head(): Promise<string | null>;
  /** Every commit, in no particular order, a page of rows at a time. */
  commits(): AsyncIterable<{ oid: string; body: Buffer }>;
  /** The objects among `oids` that exist. Callers ask for a bounded batch at a time. */
  read(oids: readonly string[]): Promise<Map<string, { type: GitObjectType; body: Buffer }>>;
}

const COMMIT_PAGE = 2000;

/** A page's repo in Postgres. */
export function pageRepo(database: Reader, paperId: string): GitRepo {
  return {
    head: () => readHead(database, paperId),
    async *commits() {
      // Keyset pages on the primary key, so a long history never sits in one result.
      let after: Buffer | null = null;
      for (;;) {
        const rows: { oid: Buffer; body: Buffer }[] = await database
          .select({ oid: pageObjects.oid, body: pageObjects.body })
          .from(pageObjects)
          .where(
            and(
              eq(pageObjects.paperId, paperId),
              eq(pageObjects.type, 'commit'),
              after ? gt(pageObjects.oid, after) : undefined,
            ),
          )
          .orderBy(asc(pageObjects.oid))
          .limit(COMMIT_PAGE);
        for (const row of rows) yield { oid: row.oid.toString('hex'), body: row.body };
        if (rows.length < COMMIT_PAGE) return;
        after = rows[rows.length - 1].oid;
      }
    },
    async read(oids) {
      const found = new Map<string, { type: GitObjectType; body: Buffer }>();
      if (oids.length === 0) return found;
      const rows = await database
        .select({ oid: pageObjects.oid, type: pageObjects.type, body: pageObjects.body })
        .from(pageObjects)
        .where(and(eq(pageObjects.paperId, paperId), inArray(pageObjects.oid, oids.map(toBytes))));
      for (const row of rows) found.set(row.oid.toString('hex'), { type: row.type, body: row.body });
      return found;
    },
  };
}

/** A repo held in memory, for tests and for objects that are not stored yet. */
export function memoryRepo(
  head: string | null,
  objects: ReadonlyMap<string, { type: GitObjectType; body: Buffer }>,
): GitRepo {
  return {
    head: async () => head,
    async *commits() {
      for (const [oid, { type, body }] of objects) if (type === 'commit') yield { oid, body };
    },
    async read(oids) {
      const found = new Map<string, { type: GitObjectType; body: Buffer }>();
      for (const oid of oids) {
        const object = objects.get(oid);
        if (object) found.set(oid, object);
      }
      return found;
    },
  };
}
