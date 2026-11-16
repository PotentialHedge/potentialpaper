import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pgErrorCode } from '@/db/errors';
import { accounts, pageClaims, pages, type Account, type PageClaimStatus } from '@/db/schema';
import { formatIdentifier, KINDS, type KeyedKind } from '@/lib/kinds';
import { ApiError } from './api/errors';
import { findKeyedPage, type PageRow } from './pages/kinds';
import type { Reader } from './pages/repo';
import { refreshPages } from './pages/refresh';

/**
 * Claims to own a page above the paper (`handoffs/pages.md` Phase 2): a venue's organisers. The author claim flow
 * (`server/claims.ts`) with the page as what is claimed: an account asks, in its own words, and an admin decides
 * (`npm run claims:decide`). There is no automatic route yet, since nothing on a venue's page says who organised it.
 *
 * A confirmed organiser of a venue is an owner (`check.ts`'s `rolesOf`) of it **and of every venue under it**: the
 * organisers of a series (`iclr`) organise its editions (`iclr/2027`). They write its `organizers/` and its
 * `venue.json`. Organising is a public role, so their commits carry their own `u_` identity; still, nothing here
 * lists who the organisers are: what they write is the page.
 *
 * Only venues take claims for now. An org's members (Phase 4) are its verified members by address, not claimants.
 */

/** As long as an author claim's evidence (`claims.ts`). */
const MAX_EVIDENCE = 2000;

/** The kinds whose owners are confirmed by a claim. */
export const CLAIMABLE_KINDS = ['venue'] as const satisfies readonly KeyedKind[];

export function isClaimable(kind: string): kind is (typeof CLAIMABLE_KINDS)[number] {
  return (CLAIMABLE_KINDS as readonly string[]).includes(kind);
}

export interface OwnPageClaim {
  status: PageClaimStatus;
  evidence: string;
  /** Whether the account owns the page through a claim on a page above it (a series' organiser on an edition). */
  inherited: boolean;
}

/** The keys a page's owners may come from: its own and every key above it (`iclr/2027` → `iclr/2027`, `iclr`). */
export function keysAbove(key: string): string[] {
  const out = [key];
  for (let at = key.lastIndexOf('/'); at > 0; at = key.lastIndexOf('/', at - 1)) out.push(key.slice(0, at));
  return out;
}

/** Whether the account is a confirmed owner of this page by claim, here or above it, and whether anyone is. */
export async function pageClaimRoles(
  db: Reader,
  page: PageRow,
  accountId: string | null,
): Promise<{ owner: boolean; claimed: boolean }> {
  if (!isClaimable(page.kind)) return { owner: false, claimed: false };
  const rows = await db
    .select({ accountId: pageClaims.accountId })
    .from(pageClaims)
    .innerJoin(pages, eq(pages.id, pageClaims.pageId))
    .where(and(eq(pages.kind, page.kind), inArray(pages.key, keysAbove(page.key)), eq(pageClaims.status, 'confirmed')));
  return { claimed: rows.length > 0, owner: accountId !== null && rows.some((row) => row.accountId === accountId) };
}

/** The account's claim on the page, or the one above it it owns the page through; `null` if neither. */
export async function ownPageClaim(
  page: PageRow,
  accountId: string,
  database: Database = getDb(),
): Promise<OwnPageClaim | null> {
  const [own] = await database
    .select({ status: pageClaims.status, evidence: pageClaims.evidence })
    .from(pageClaims)
    .where(and(eq(pageClaims.pageId, page.id), eq(pageClaims.accountId, accountId)));
  if (own?.status === 'confirmed') return { ...own, inherited: false };
  const { owner } = await pageClaimRoles(database, page, accountId);
  if (owner) return { status: 'confirmed', evidence: '', inherited: true };
  return own ? { ...own, inherited: false } : null;
}

async function refreshPage(page: PageRow): Promise<void> {
  if (page.kind === 'paper') return;
  await refreshPages({ kind: page.kind, key: page.key });
}

/**
 * Asks to be confirmed as one of the page's owners: a venue's organisers. A pending claim can be changed by asking
 * again; a decided one can't.
 */
export async function requestPageClaim(
  page: PageRow,
  account: Account,
  input: { evidence: string },
  database: Database = getDb(),
): Promise<OwnPageClaim> {
  if (!isClaimable(page.kind)) {
    throw new ApiError(422, 'validation_error', `a ${KINDS[page.kind].title.toLowerCase()} page can't be claimed`);
  }
  if (account.isBot) throw new ApiError(403, 'forbidden', 'a bot cannot organise a venue');
  if (!account.verifiedAt) throw new ApiError(403, 'forbidden', 'confirm an institutional email address first');
  const evidence = input.evidence.trim().slice(0, MAX_EVIDENCE);
  if (!evidence) {
    throw new ApiError(422, 'validation_error', 'say who you are at the venue, and where that can be checked');
  }
  const existing = await ownPageClaim(page, account.id, database);
  if (existing?.inherited) {
    throw new ApiError(409, 'claim_decided', 'you already organise this venue, through the series');
  }
  if (existing && existing.status !== 'pending') {
    throw new ApiError(409, 'claim_decided', `your claim was already ${existing.status}`);
  }
  try {
    await database
      .insert(pageClaims)
      .values({ pageId: page.id, accountId: account.id, evidence })
      .onConflictDoUpdate({ target: [pageClaims.pageId, pageClaims.accountId], set: { evidence } });
  } catch (err) {
    if (pgErrorCode(err) !== '23505') throw err;
    throw new ApiError(503, 'page_busy', 'could not record the claim; try again');
  }
  return { status: 'pending', evidence, inherited: false };
}

/**
 * Takes back a claim that is waiting, or steps down as a confirmed organiser. Rejected claims stay, so the same
 * claim isn't made again.
 */
export async function withdrawPageClaim(page: PageRow, accountId: string, database: Database = getDb()) {
  const removed = await database
    .delete(pageClaims)
    .where(
      and(
        eq(pageClaims.pageId, page.id),
        eq(pageClaims.accountId, accountId),
        inArray(pageClaims.status, ['pending', 'confirmed']),
      ),
    )
    .returning({ status: pageClaims.status });
  if (removed.length === 0) throw new ApiError(404, 'not_found', 'you have no claim on this page to take back');
  if (removed[0].status === 'confirmed') await refreshPage(page);
}

/** An admin's decision. */
export async function decidePageClaim(
  claimId: string,
  status: 'confirmed' | 'rejected',
  decidedBy: string | null,
  database: Database = getDb(),
) {
  const [row] = await database
    .update(pageClaims)
    .set({ status, decidedBy, decidedAt: new Date() })
    .where(eq(pageClaims.id, claimId))
    .returning();
  if (!row) throw new ApiError(404, 'not_found', 'no such claim');
  const [page] = await database
    .select({ id: pages.id, kind: pages.kind, key: pages.key })
    .from(pages)
    .where(eq(pages.id, row.pageId));
  if (page) await refreshPage(page);
  return {
    ...row,
    identifier: page && page.kind !== 'paper' ? formatIdentifier({ kind: page.kind, key: page.key }) : null,
  };
}

/** Whether there is a page claim with this id, so `claims:decide` knows which kind of claim it was given. */
export async function isPageClaim(claimId: string, database: Database = getDb()): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(claimId)) return false;
  const [row] = await database.select({ id: pageClaims.id }).from(pageClaims).where(eq(pageClaims.id, claimId));
  return Boolean(row);
}

/** Page claims waiting for a decision, oldest first, with who made them. For admins only. */
export async function pendingPageClaims(database: Database = getDb()) {
  const rows = await database
    .select({
      id: pageClaims.id,
      kind: pages.kind,
      key: pages.key,
      evidence: pageClaims.evidence,
      handle: accounts.handle,
      realName: accounts.realName,
      institutions: accounts.institutions,
      createdAt: pageClaims.createdAt,
    })
    .from(pageClaims)
    .innerJoin(pages, eq(pages.id, pageClaims.pageId))
    .innerJoin(accounts, eq(accounts.id, pageClaims.accountId))
    .where(eq(pageClaims.status, 'pending'))
    .orderBy(asc(pageClaims.createdAt));
  return rows.map(({ kind, key, ...row }) => ({
    ...row,
    identifier: kind === 'paper' ? key : formatIdentifier({ kind, key }),
  }));
}

/** The keyed page a claim names, by its kind and key, or a 404. */
export async function mustFindClaimable(kind: KeyedKind, key: string, database: Database = getDb()): Promise<PageRow> {
  const page = await findKeyedPage(database, kind, key);
  if (!page || !isClaimable(page.kind)) throw new ApiError(404, 'not_found', `no ${kind} page ${key}`);
  return page;
}
