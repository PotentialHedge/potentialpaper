import 'dotenv/config';
import { getPool } from '@/db';
import { rebuildPaperRatings } from '@/server/paper-ratings';

/** Writes every paper's rating (`paper_ratings`, the home list's rating sort) from its submissions and reviews. */
async function main() {
  const n = await rebuildPaperRatings();
  console.log(`${n} papers rated.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
