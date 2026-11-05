import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { getPool } from '@/db';
import { importSubmissions, type Submission } from '@/server/import-submissions';

/**
 * Imports ICLR 2027 submissions from acceptodds' scrape:
 * `npm run papers:import-iclr -- ../papermarket/platform/data/iclr2027.sqlite`
 */
async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: papers:import-iclr <path to iclr2027.sqlite>');
  const sqlite = new DatabaseSync(path, { readOnly: true });
  const rows = sqlite.prepare('select id, title, abstract from submissions').all() as unknown as Submission[];
  const added = await importSubmissions(rows, { name: 'ICLR 2027 (under review)', year: 2027 });
  console.log(`read ${rows.length} submissions, added ${added}`);
  sqlite.close();
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
