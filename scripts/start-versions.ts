import 'dotenv/config';
import { parseArgs } from 'node:util';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { PAPER_SOURCES, startVersions } from '@/server/papers';

const USAGE = `Gives every paper without versions the ones its source lists (arXiv, OpenAlex), as the system, as a
lookup does for a paper new here. A paper always has at least one version. Asks each source at its own pace.

  npm run papers:start-versions [-- --dry-run]`;

const PACE_MS: Record<string, number> = { arxiv: 3_100, doi: 1_000 };

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) return console.log(USAGE);
  const db = getDb();
  // Each paper without versions, by the identifier of a source that can describe it, arXiv's first.
  const { rows } = await db.execute<{ id: string; scheme: string; value: string; title: string }>(sql`
    select distinct on (p.id) p.id, i.scheme, i.value, p.title
    from papers p
    join paper_identifiers i on i.paper_id = p.id and i.scheme in ('arxiv', 'doi')
    left join page_current c on c.page_id = p.id
    where p.merged_into is null and coalesce(jsonb_array_length(c.versions), 0) = 0
    order by p.id, i.scheme`);
  console.log(`${rows.length} papers without versions`);
  let started = 0;
  for (const row of rows) {
    const source = PAPER_SOURCES[row.scheme as 'arxiv' | 'doi'];
    if (!source) continue;
    const described = await source.fetch(row.value).catch((err) => {
      console.error(`${row.scheme}:${row.value}: ${String(err)}`);
      return null;
    });
    if (!described?.versions.length) console.log(`${row.scheme}:${row.value} lists no versions`);
    else if (values['dry-run'])
      console.log(`${row.scheme}:${row.value} ${described.versions.map((v) => v.label).join(', ')}`);
    else if (await startVersions(row.id, described, db)) {
      started += 1;
      console.log(`${row.scheme}:${row.value} ${row.title}`);
    }
    await new Promise((resolve) => setTimeout(resolve, PACE_MS[row.scheme]));
  }
  console.log(`started the versions of ${started} papers`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
