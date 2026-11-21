import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { syncVenuePages } from '@/server/venue-pages';

const USAGE = `The \`venues\` bot (handoffs/pages.md Phase 2): makes a series' and an edition's venue pages (/v/iclr,
/v/iclr/2027) for every venue the site knows from its imports (the \`venues\` table), each with a venue.json whose
sources make the venue's submissions the edition's papers. Idempotent: it never removes anything, and on a page whose
venue.json is there it only adds a missing source. An import tool's POST /api/v1/imports/venues runs it for its venues.

  npm run venues:sync`;

async function main() {
  const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const report = await syncVenuePages();
  for (const key of report.written) console.log(`wrote venue:${key}`);
  for (const id of report.skipped) console.log(`no page yet for ${id} (not a conference's main edition)`);
  console.log(`${report.written.length} pages written, ${report.skipped.length} venues skipped`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
