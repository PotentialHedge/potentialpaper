import { getDb, type Database } from '@/db';
import { type ClaimPolicy, KINDS, type PageAddress } from '@/lib/kinds';
import { toolPath } from '@/lib/page-tools';
import { confirmedAuthors } from './claims';
import { orgDomains } from './org-roles';
import { pageClaimRoles } from './page-claims';
import type { PageRow } from './pages/kinds';

/**
 * What a page shows about its owners (`lib/kinds.ts`, `KINDS[kind].owners`), the same way on every kind: who they are,
 * whether anyone is yet, and where to become one. Who may write is `pages/check.ts`'s `rolesOf`; this is only what
 * the page says, so it names owners only where that is public (a paper's confirmed authors, by the names on it).
 */
export interface OwnersInfo {
  /** "the authors". */
  title: string;
  claim: ClaimPolicy;
  /** Whether anyone owns it yet; an org has owners once it has a domain to be a member at. */
  claimed: boolean;
  /** The owners by name, where the page names them: a paper's confirmed authors. */
  names: string[];
  /** Where to claim it, or how to become one; `null` on a person's page. */
  claimPath: string | null;
}

export async function ownersOf(
  page: PageRow,
  address: PageAddress,
  database: Database = getDb(),
): Promise<OwnersInfo | null> {
  const owners = KINDS[page.kind].owners;
  if (!owners) return null;
  const base = {
    title: owners.title,
    claim: owners.claim,
    names: [] as string[],
    claimPath: toolPath('claim', address),
  };
  switch (owners.claim) {
    case 'authors': {
      const names = (await confirmedAuthors(page.id, database)).map((author) => author.authorName);
      return { ...base, claimed: names.length > 0, names };
    }
    case 'organisers':
      return { ...base, claimed: (await pageClaimRoles(database, page, null)).claimed };
    case 'domain':
      return { ...base, claimed: (await orgDomains(database, page)).length > 0 };
    case 'self':
      return { ...base, claimed: true, claimPath: null };
  }
}
