import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getDb, getPool } from '@/db';
import { pageRefs } from '@/db/schema';
import { recordLfsObject } from '@/server/lfs';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { planLfs } from '@/server/pages/layout-migration';
import { readCommit, readFiles, readText } from '@/server/pages/repo';

const USAGE = `Moves every page repo's PDFs and picture to Git LFS pointers (src/server/pages/rules.ts), and gives it
the .gitattributes that says so: a system commit per page that needs one. Safe to run again: a page already
moved is skipped. Run it straight after deploying, as edits to a page that isn't moved yet are refused.

  npm run pages:migrate-lfs [-- --dry-run]

Afterwards, purge the edge cache (scripts/purge-edge-cache.sh), as for a deploy.`;

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const db = getDb();
  const refs = await db.select({ paperId: pageRefs.pageId, head: pageRefs.head }).from(pageRefs);
  let moved = 0;
  let failed = 0;
  for (const [index, { paperId, head }] of refs.entries()) {
    const oid = head.toString('hex');
    const files = new Map<string, string>();
    for (const [path, blob] of await readFiles(db, paperId, (await readCommit(db, paperId, oid)).tree)) {
      files.set(path, (await readText(db, paperId, blob)) ?? '');
    }
    const { changes, stored } = planLfs(files);
    if (changes.length === 0) continue;
    if (values['dry-run']) {
      console.log(`${paperId}: ${changes.map((c) => `${c.content === null ? '-' : '+'}${c.path}`).join(' ')}`);
      moved += 1;
      continue;
    }
    try {
      for (const file of stored) await recordLfsObject(db, file);
      await commitPage(paperId, oid, SYSTEM_ACTOR, changes, 'Keep the PDFs and the picture with Git LFS', {
        migration: true,
      });
      moved += 1;
    } catch (err) {
      failed += 1;
      const details = (err as { details?: unknown }).details;
      console.error(`${paperId}: ${(err as Error).message}`, details ? JSON.stringify(details) : '');
    }
    if ((index + 1) % 1000 === 0) console.log(`${index + 1} of ${refs.length} pages looked at`);
  }
  console.log(`${values['dry-run'] ? 'would move' : 'moved'} ${moved} of ${refs.length} pages; ${failed} failed`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
