import 'dotenv/config';
import { getPool } from '@/db';
import { rebuildAllPages } from '@/server/pages/projections';

/** Remakes `page_revisions` and `page_current` from the git objects. Safe to run while the site is up. */
async function main() {
  const { pages, commits } = await rebuildAllPages();
  console.log(`rebuilt ${pages} pages from ${commits} commits`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
