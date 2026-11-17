import { sql } from 'drizzle-orm';
import type { PageRow } from './pages/kinds';
import type { Reader } from './pages/repo';
import { keysAbove } from './page-claims';

/**
 * Who an org page's members are (`handoffs/pages.md` Phase 4): the accounts with a confirmed address at one of its
 * `org.json` `domains`, or under one (`inf.ethz.ch` under `ethz.ch`), on the page itself or on an org above it by
 * address (a lab's members include its institution's). They own its `members/` and its `org.json` (`check.ts`'s
 * `rolesOf`), and may make departments and labs under it (`server/org-pages.ts`).
 *
 * Read from `page_current.kind_file`, written in the commit's transaction, so a domain added counts at once.
 */
export async function isOrgMember(db: Reader, page: PageRow, accountId: string): Promise<boolean> {
  if (page.kind !== 'org') return false;
  const keys = keysAbove(page.key);
  const { rows } = await db.execute<{ member: boolean }>(sql`
    select exists (
      select 1
        from affiliations f
        cross join lateral domain_suffixes(split_part(f.email, '@', 2)) s(domain)
        join pages p on p.kind = 'org' and p.key in (${sql.join(
          keys.map((key) => sql`${key}`),
          sql`, `,
        )})
        join page_current c on c.page_id = p.id
       where f.account_id = ${accountId}
         and f.verified_at is not null
         and jsonb_typeof(c.kind_file -> 'domains') = 'array'
         and jsonb_exists(c.kind_file -> 'domains', s.domain)
    ) as member
  `);
  return rows[0]?.member === true;
}

/** The domains of the org pages above this one by address (`eth` above `eth/inf`), not its own. */
export async function domainsAbove(db: Reader, page: PageRow): Promise<string[]> {
  const keys = keysAbove(page.key).slice(1);
  if (keys.length === 0) return [];
  const { rows } = await db.execute<{ domain: string }>(sql`
    select distinct jsonb_array_elements_text(c.kind_file -> 'domains') as domain
      from pages p join page_current c on c.page_id = p.id
     where p.kind = 'org' and p.key in (${sql.join(
       keys.map((key) => sql`${key}`),
       sql`, `,
     )})
       and jsonb_typeof(c.kind_file -> 'domains') = 'array'
  `);
  return rows.map((row) => row.domain);
}
