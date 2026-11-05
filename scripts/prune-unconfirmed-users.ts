import 'dotenv/config';
import { getPool } from '@/db';
import { pruneUnconfirmedUsers, UNCONFIRMED_USER_TTL_DAYS } from '@/server/onboarding';

/** Weekly from the host's cron. `--older-than-days N` overrides the default age. */
async function main() {
  const at = process.argv.indexOf('--older-than-days');
  const olderThanDays = at >= 0 ? Number(process.argv[at + 1]) : UNCONFIRMED_USER_TTL_DAYS;
  if (!(olderThanDays >= 1)) throw new Error('--older-than-days must be at least 1');
  console.log(`pruned ${await pruneUnconfirmedUsers({ olderThanDays })} unconfirmed users`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
