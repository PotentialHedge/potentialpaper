import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { pageObjects, pageRefs } from '@/db/schema';
import type { GitObject, GitObjectType } from '../pages/git-objects';
import type { Writer } from '../pages/projections';
import type { Reader } from '../pages/repo';

/**
 * A page's git objects, and nothing about where they live. Each page's repo is its rows in `page_objects` and
 * `page_refs` (DESIGN.md §4.1); tests can hand in a map. **Nothing else reads or writes `page_objects`**, so
 * moving the bodies elsewhere (packs in R2, §4.11) changes only this file.
 */
export interface GitRepo {
  /** `refs/heads/main`, the only ref, or `null` when the repo has no commit yet. */
  head(): Promise<string | null>;
  /** Every commit, in no particular order, a page of rows at a time. */
  commits(): AsyncIterable<{ oid: string; body: Buffer }>;
  /** The objects among `oids` that exist. Callers ask for a bounded batch at a time. */
  read(oids: readonly string[]): Promise<Map<string, { type: GitObjectType; body: Buffer }>>;
  /** The size in bytes of each object among `oids` that exists, without reading its body. */
  sizes(oids: readonly string[]): Promise<Map<string, number>>;
}

/** A repo that can also store objects. Objects never change, so storing one that is there already does nothing. */
export interface WritableGitRepo extends GitRepo {
  write(objects: readonly GitObject[]): Promise<void>;
}

export function toBytes(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

export async function readHead(db: Reader, paperId: string): Promise<string | null> {
  const [row] = await db.select({ head: pageRefs.head }).from(pageRefs).where(eq(pageRefs.paperId, paperId));
  return row ? row.head.toString('hex') : null;
}

const COMMIT_PAGE = 2000;

/** A page's repo in Postgres. Given a transaction that can write, it can store objects too. */
export function pageRepo(database: Writer, paperId: string): WritableGitRepo;
export function pageRepo(database: Reader, paperId: string): GitRepo;
export function pageRepo(database: Reader | Writer, paperId: string): GitRepo | WritableGitRepo {
  const repo: GitRepo = {
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
    async sizes(oids) {
      if (oids.length === 0) return new Map();
      const rows = await database
        .select({ oid: pageObjects.oid, bytes: sql<number>`octet_length(${pageObjects.body})` })
        .from(pageObjects)
        .where(and(eq(pageObjects.paperId, paperId), inArray(pageObjects.oid, oids.map(toBytes))));
      return new Map(rows.map((row) => [row.oid.toString('hex'), Number(row.bytes)]));
    },
  };
  if (!('insert' in database)) return repo;
  return {
    ...repo,
    async write(objects) {
      if (objects.length === 0) return;
      await database
        .insert(pageObjects)
        .values(objects.map(({ oid, type, body }) => ({ paperId, oid: toBytes(oid), type, body })))
        .onConflictDoNothing();
    },
  };
}

/**
 * A repo held in memory, for tests and for objects that are not stored yet. It reads `objects` as it is at the
 * time, and keeps what is written apart from it.
 */
export function memoryRepo(
  head: string | null,
  objects: ReadonlyMap<string, { type: GitObjectType; body: Buffer }>,
): WritableGitRepo {
  const written = new Map<string, { type: GitObjectType; body: Buffer }>();
  const get = (oid: string) => objects.get(oid) ?? written.get(oid);
  return {
    head: async () => head,
    async *commits() {
      for (const [oid, { type, body }] of objects) if (type === 'commit') yield { oid, body };
      for (const [oid, { type, body }] of written) if (type === 'commit' && !objects.has(oid)) yield { oid, body };
    },
    async read(oids) {
      const found = new Map<string, { type: GitObjectType; body: Buffer }>();
      for (const oid of oids) {
        const object = get(oid);
        if (object) found.set(oid, object);
      }
      return found;
    },
    async sizes(oids) {
      const found = new Map<string, number>();
      for (const oid of oids) {
        const object = get(oid);
        if (object) found.set(oid, object.body.length);
      }
      return found;
    },
    async write(objectsToWrite) {
      for (const { oid, type, body } of objectsToWrite) if (!get(oid)) written.set(oid, { type, body });
    },
  };
}
