import { sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { keyedPagePath } from '@/lib/kinds';
import { ttlCache } from './ttl-cache';

/**
 * Where an institution or a venue named in passing has its page here: an account's institutions ("ETH Zurich") and a
 * paper's venue ("ICLR 2027") are kept as names, so each is looked up by the name its page shows (`page_current.name`).
 * An institution is a top-level org page (each name on the allowlist has one, `server/org-pages.ts`); a venue is a
 * series or an edition (`lib/venues.ts`), and only a conference's main edition has one, so a workshop's name stays
 * text. Read leniently: a name with no page has no path, and where two pages show one name the first by key wins.
 */

type Kind = 'org' | 'venue';

/** Every page of a kind by its name, kept ten minutes: a few thousand short rows. */
const byName = ttlCache<ReadonlyMap<string, string>>(10 * 60_000, 2, { staleMs: 60 * 60_000 });

function pathsByName(kind: Kind, database: Database): Promise<ReadonlyMap<string, string>> {
  const load = async () => {
    const { rows } = await database.execute<{ key: string; name: string }>(sql`
      select p.key, c.name from pages p join page_current c on c.page_id = p.id
       where p.kind = ${kind} and c.name is not null
         ${kind === 'org' ? sql`and position('/' in p.key) = 0` : sql``}
       order by p.key`);
    const paths = new Map<string, string>();
    for (const row of rows) if (!paths.has(row.name)) paths.set(row.name, keyedPagePath(kind, row.key));
    return paths;
  };
  return database === getDb() ? byName(kind, load) : load();
}

/** The paths of the named pages that exist, by name: a plain object, to hand to a client component. */
async function pathsOf(
  kind: Kind,
  names: Iterable<string | null | undefined>,
  database: Database,
): Promise<Record<string, string>> {
  const paths = await pathsByName(kind, database);
  const out: Record<string, string> = {};
  for (const name of names) {
    const path = name ? paths.get(name) : undefined;
    if (name && path) out[name] = path;
  }
  return out;
}

/** The org pages of institutions, by name. */
export function institutionPaths(
  names: Iterable<string | null | undefined>,
  database: Database = getDb(),
): Promise<Record<string, string>> {
  return pathsOf('org', names, database);
}

/** The venue pages of venues, by the name a paper or submission gives ("ICLR 2027"). */
export function venuePaths(
  names: Iterable<string | null | undefined>,
  database: Database = getDb(),
): Promise<Record<string, string>> {
  return pathsOf('venue', names, database);
}
