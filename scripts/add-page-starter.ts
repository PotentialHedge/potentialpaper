import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getDb, getPool } from '@/db';
import { pageRefs, pages } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { readCommit, readFiles, readText } from '@/server/pages/repo';
import { PREK_PATH, README_PATH } from '@/server/pages/rules';
import { missingStarterFiles } from '@/server/pages/starter';

const USAGE = `Gives every page repo the files a new page starts with (src/server/pages/starter.ts): prek.toml and README.md
as they are now, and on a paper empty sections for each part that has none. A system commit per page that needs one;
safe to run again. Run it again when prek.toml or README.md changes (a new site address, new hook versions).

  npm run pages:add-starter [-- --dry-run]`;

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const db = getDb();
  const refs = await db
    .select({ paperId: pageRefs.pageId, head: pageRefs.head, kind: pages.kind })
    .from(pageRefs)
    .innerJoin(pages, eq(pages.id, pageRefs.pageId));
  let changed = 0;
  let failed = 0;
  for (const [index, { paperId, head, kind }] of refs.entries()) {
    const oid = head.toString('hex');
    const files = await readFiles(db, paperId, (await readCommit(db, paperId, oid)).tree);
    const prek = (await readText(db, paperId, files.get(PREK_PATH))) ?? undefined;
    const readme = (await readText(db, paperId, files.get(README_PATH))) ?? undefined;
    const changes = missingStarterFiles(new Set(files.keys()), { prek, readme }, kind);
    if (changes.length === 0) continue;
    if (values['dry-run']) {
      console.log(`${paperId}: ${changes.map((c) => c.path).join(' ')}`);
      changed += 1;
      continue;
    }
    try {
      await commitPage(paperId, oid, SYSTEM_ACTOR, changes, 'Add the files every page starts with', {
        migration: true,
      });
      changed += 1;
    } catch (err) {
      failed += 1;
      const details = (err as { details?: unknown }).details;
      console.error(`${paperId}: ${(err as Error).message}`, details ? JSON.stringify(details) : '');
    }
    if ((index + 1) % 1000 === 0) console.log(`${index + 1} of ${refs.length} pages looked at`);
  }
  console.log(`${values['dry-run'] ? 'would change' : 'changed'} ${changed} of ${refs.length} pages; ${failed} failed`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
