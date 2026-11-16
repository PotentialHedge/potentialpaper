import { sql } from 'drizzle-orm';
import type { Database } from '@/db';
import type { Consumer } from './consumers/types';
import { readCommit, readFiles, readText, toBytes } from './pages/repo';
import { fileTypeOf, indexFile, PAGE_SCHEMAS, searchScopeOf, type FileType } from './pages/schemas';

/**
 * The search index's writer (DESIGN.md §4.10): the `search` outbox consumer, which brings a page's rows in
 * `search_docs` up to a commit. It lists the commit's files, keeps the rows of every file whose blob id is
 * unchanged without reading it, and indexes the rest with their type's indexer (`pages/schemas.ts`). A file
 * that no longer exists, or no longer has an indexer, loses its rows. Re-running it at the same head changes
 * nothing, as a consumer must.
 *
 * Indexers changing (a new field, a new type) doesn't touch rows already written: run
 * `npm run consumers:rebuild -- search`, which empties the table and replays every page.
 */

/** The snippet marks (`lib/search.ts`), which indexed text never holds. */
const MARKS = /[\uE000\uE001]/g;

/** Git's id of an empty file: every page starts with a dozen (`starter.ts`), and they hold nothing to find. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** Whether a path is searched at all, so a file that isn't is never read. */
function isIndexed(path: string): boolean {
  const name = fileTypeOf(path);
  return name !== null && (PAGE_SCHEMAS[name] as FileType).index !== undefined;
}

interface Row extends Record<string, unknown> {
  path: string;
  blob: string;
}

export interface IndexReport {
  /** Files read and indexed again. */
  indexed: number;
  /** Files whose rows were dropped: gone, or no longer searched. */
  removed: number;
}

/** Brings `paperId`'s search documents up to commit `head`. */
export async function indexPage(database: Database, paperId: string, head: string): Promise<IndexReport> {
  const commit = await readCommit(database, paperId, head);
  const files = await readFiles(database, paperId, commit.tree);
  const wanted = new Map([...files].filter(([path, blob]) => blob !== EMPTY_BLOB && isIndexed(path)));

  return database.transaction(async (tx) => {
    // One indexer at a time per page, so two workers that both took a page (a lease lost mid-batch) can't
    // interleave their deletes and inserts.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`search:${paperId}`}, 0))`);
    const { rows } = await tx.execute<Row>(
      sql`select distinct path, encode(blob_oid, 'hex') as blob from search_docs where paper_id = ${paperId}`,
    );
    const held = new Map(rows.map((row) => [row.path, row.blob]));

    const stale = [...held.keys()].filter((path) => wanted.get(path) !== held.get(path));
    if (stale.length > 0) {
      await tx.execute(
        sql`delete from search_docs where paper_id = ${paperId} and path = any(${sql.param(stale)}::text[])`,
      );
    }

    let indexed = 0;
    for (const [path, blob] of wanted) {
      if (held.get(path) === blob) continue;
      indexed += 1;
      const text = (await readText(tx, paperId, blob)) ?? '';
      const docs = indexFile(path, text) ?? [];
      const scope = searchScopeOf(path);
      if (!scope) continue;
      for (const [n, doc] of docs.entries()) {
        await tx.execute(sql`
          insert into search_docs (paper_id, path, n, blob_oid, kind, scope, text, fields)
          values (${paperId}, ${path}, ${n}, ${toBytes(blob)}, ${doc.kind}, ${scope},
                  ${doc.text.replace(MARKS, ' ')}, ${JSON.stringify(doc.fields ?? {})}::jsonb)
        `);
      }
    }
    return { indexed, removed: stale.filter((path) => !wanted.has(path)).length };
  });
}

export const searchConsumer: Consumer = {
  name: 'search',
  async handle(paperId, head, { database }) {
    await indexPage(database, paperId, head);
  },
  async reset({ database }) {
    await database.execute(sql`truncate search_docs`);
  },
};
