import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { getDb, getPool } from '@/db';
import { pageRefs, pages } from '@/db/schema';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { planOwners } from '@/server/pages/layout-migration';
import { readCommit, readFiles, readText } from '@/server/pages/repo';

const USAGE = `Moves every page's owners' part to owners/ (layout 4, src/server/pages/rules.ts), a system commit per page
that needs one. Safe to run again: a page already moved is skipped.

  npm run pages:migrate-owners [-- --dry-run]

Afterwards, purge the edge cache (scripts/purge-edge-cache.sh), as for a deploy.`;

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const db = getDb();
  const refs = await db
    .select({ pageId: pageRefs.pageId, head: pageRefs.head, kind: pages.kind })
    .from(pageRefs)
    .innerJoin(pages, eq(pages.id, pageRefs.pageId));
  let moved = 0;
  let failed = 0;
  for (const [index, { pageId, head, kind }] of refs.entries()) {
    const oid = head.toString('hex');
    const files = new Map<string, string>();
    for (const [path, blob] of await readFiles(db, pageId, (await readCommit(db, pageId, oid)).tree)) {
      files.set(path, (await readText(db, pageId, blob)) ?? '');
    }
    const changes = planOwners(kind, files);
    if (changes.length === 0) continue;
    if (values['dry-run']) {
      console.log(`${kind} ${pageId}: ${changes.map((c) => `${c.content === null ? '-' : '+'}${c.path}`).join(' ')}`);
      moved += 1;
      continue;
    }
    try {
      await commitPage(pageId, oid, SYSTEM_ACTOR, changes, 'Move the owners’ sections to owners/', { migration: true });
      moved += 1;
    } catch (err) {
      failed += 1;
      const details = (err as { details?: unknown }).details;
      console.error(`${pageId}: ${(err as Error).message}`, details ? JSON.stringify(details) : '');
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
