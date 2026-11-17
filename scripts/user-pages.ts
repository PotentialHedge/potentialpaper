import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getDb, getPool } from '@/db';
import { accounts } from '@/db/schema';
import { syncProfileFile } from '@/server/user-pages';

const USAGE = `Every account's page at /u/<handle> (handoffs/pages.md Phase 3): migration 0037 made a page for each
account, and this starts each one's repo and writes its profile.json from the account's user.show.* settings.
Idempotent: a page whose profile.json already says what the settings do is left alone.

  npm run users:pages`;

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const rows = await getDb().select({ id: accounts.id, handle: accounts.handle }).from(accounts);
  const counts = { committed: 0, unchanged: 0, 'no-page': 0 };
  for (const account of rows) {
    const result = await syncProfileFile(account);
    counts[result] += 1;
    if (result === 'committed') console.log(`wrote user:${account.handle}`);
    if (result === 'no-page') console.log(`no page for @${account.handle}`);
  }
  console.log(`${rows.length} accounts: ${counts.committed} written, ${counts.unchanged} unchanged`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
