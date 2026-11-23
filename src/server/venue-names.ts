import { sql } from 'drizzle-orm';
import type { Database } from '@/db';
import type { Consumer } from './consumers/types';
import { reprojectCurrent } from './pages/projections';

/**
 * The `venue-names` outbox consumer (DESIGN.md §4.9): a venue's name is kept once, in its page's `venue.json`, and a
 * paper's version that names the page (`"page": "neurips/2026"`) shows it (`pages/venue-projection.ts`). When a venue
 * page's name changes, this writes again the `page_current` of each paper whose versions still show the old one, out of
 * the venue's commit, so a rename never waits on every paper at the venue. Idempotent: a paper already showing the
 * name is left alone.
 */

/** The papers whose versions name the venue page `key` but show a name other than `name`. */
export async function papersShowingOtherName(database: Database, key: string, name: string): Promise<string[]> {
  const { rows } = await database.execute<{ page_id: string }>(sql`
    select page_id from page_current
     where versions is not null
       and jsonb_path_exists(versions, '$[*].submissions[*] ? (@.page == $key && @.venue != $name)',
                             jsonb_build_object('key', ${key}::text, 'name', ${name}::text))
  `);
  return rows.map((row) => row.page_id);
}

/** Brings every paper naming the venue page `pageId` up to its name; how many it wrote. */
export async function syncVenueNames(database: Database, pageId: string): Promise<number> {
  const { rows } = await database.execute<{ key: string; name: string }>(sql`
    select p.key, coalesce(c.name, p.key) as name
      from pages p left join page_current c on c.page_id = p.id
     where p.id = ${pageId} and p.kind = 'venue'
  `);
  if (rows.length === 0) return 0;
  const papers = await papersShowingOtherName(database, rows[0].key, rows[0].name);
  for (const paperId of papers) await reprojectCurrent(paperId, database);
  return papers.length;
}

export const venueNamesConsumer: Consumer = {
  name: 'venue-names',
  kinds: ['venue'],
  async handle(pageId, _head, { database }) {
    await syncVenueNames(database, pageId);
  },
};
