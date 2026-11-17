import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { pageCurrent, pageRefs, paperIdentifiers } from '@/db/schema';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { recordLfsObject } from '@/server/lfs';
import { encodeLfsPointer, encodePdfSource, PAPER_PDF_PATH, PDF_PATH, PDF_TYPE } from '@/server/pages/rules';
import type { ManifestRow } from './upload-pdfs';

/**
 * Commits a `.potentialpaper/paper.pdf` (a Git LFS pointer) and its `pdf.json` to the page of each paper in a
 * manifest from `upload-pdfs`. Safe to run again: a
 * page that already points at those bytes is skipped.
 *
 *   npm run papers:attach-pdfs -- data/iclr2027.jsonl
 */
const PDF_BASE = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
const WORKERS = 4;

async function main() {
  const [manifest] = process.argv.slice(2);
  if (!manifest) throw new Error('usage: papers:attach-pdfs <manifest>');
  const rows = readFileSync(manifest, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ManifestRow);

  const known = await getDb()
    .select({
      value: paperIdentifiers.value,
      paperId: paperIdentifiers.paperId,
      head: sql<string | null>`encode(${pageRefs.head}, 'hex')`,
      sha256: sql<string | null>`${pageCurrent.pdf} ->> 'sha256'`,
    })
    .from(paperIdentifiers)
    .leftJoin(pageRefs, eq(pageRefs.pageId, paperIdentifiers.paperId))
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, paperIdentifiers.paperId))
    .where(eq(paperIdentifiers.scheme, 'openreview'));
  const pages = new Map(known.map((row) => [row.value, row]));

  let committed = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: WORKERS }, async () => {
      while (next < rows.length) {
        const row = rows[next++];
        const page = pages.get(row.id);
        if (!page) {
          missing += 1;
          continue;
        }
        if (page.sha256 === row.sha256) {
          skipped += 1;
          continue;
        }
        const source = {
          source: `https://openreview.net/forum?id=${row.id}`,
          license: row.license,
          fetchedAt: row.fetchedAt,
        };
        try {
          const url = `${PDF_BASE}/pdf/${row.sha256}.pdf`;
          await recordLfsObject(getDb(), { sha256: row.sha256, bytes: row.bytes, type: PDF_TYPE, url });
          await commitPage(
            page.paperId,
            page.head,
            SYSTEM_ACTOR,
            [
              { path: PAPER_PDF_PATH, content: encodeLfsPointer(row) },
              { path: PDF_PATH, content: encodePdfSource(source) },
            ],
            'Add the PDF',
          );
          committed += 1;
          if (committed % 1000 === 0) console.log(`${committed} committed`);
        } catch (err) {
          failed += 1;
          console.error(`${row.id}: ${String(err)}`);
        }
      }
    }),
  );
  console.log(`committed ${committed}, already there ${skipped}, no such paper ${missing}, failed ${failed}`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
