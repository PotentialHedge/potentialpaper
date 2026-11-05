import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { getPool } from '@/db';
import { importSubmissions, type Submission } from '@/server/import-submissions';

/**
 * Imports ICLR submissions from a scrape:
 * `npm run papers:import-iclr -- ../papermarket/research/data/iclr2027.sqlite 2027`
 *
 * 2027 is still under review, so its authors are never read. A 2026 paper is named as an ICLR paper
 * only if it was accepted, and stays a neutral "submission" otherwise.
 */
const UNDER_REVIEW = new Set([2027]);

interface Row {
  id: string;
  title: string;
  abstract: string | null;
  authors: string | null;
  accepted: number | null;
}

function toSubmission(row: Row, year: number): Submission {
  const { id, title, abstract } = row;
  if (UNDER_REVIEW.has(year)) return { id, title, abstract };
  return {
    id,
    title,
    abstract,
    authors: JSON.parse(row.authors ?? '[]') as string[],
    venue: row.accepted === 1 ? `ICLR ${year}` : `ICLR ${year} submission`,
  };
}

async function main() {
  const [path, yearText = '2027'] = process.argv.slice(2);
  const year = Number(yearText);
  if (!path || !Number.isInteger(year)) throw new Error('usage: papers:import-iclr <path to sqlite> [year]');
  const sqlite = new DatabaseSync(path, { readOnly: true });
  const rows = sqlite
    .prepare(
      `select s.id, s.title, s.abstract, s.authors, d.accepted
       from submissions s left join decisions d on d.forum = s.id`,
    )
    .all() as unknown as Row[];
  const venue = { name: `ICLR ${year} (under review)`, year };
  const added = await importSubmissions(
    rows.map((row) => toSubmission(row, year)),
    venue,
  );
  console.log(`read ${rows.length} submissions, added ${added}`);
  sqlite.close();
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
