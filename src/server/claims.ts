import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pgErrorCode } from '@/db/errors';
import { accounts, authorClaims, papers, type Account, type AuthorClaim, type ClaimStatus } from '@/db/schema';
import { ApiError } from './api/errors';
import { newIdentity } from './pages/commit';

/**
 * Claims of authorship (DESIGN.md §6). A paper is claimed once one of its printed authors has a confirmed
 * claim, and unclaimed until then. A claim names which author the account says it is, with the evidence
 * in their own words. **How a claim is verified is not settled yet:** for now an admin reads the evidence
 * and decides (`scripts/decide-claim.ts`), the "manual" route of the design. Nothing here is automatic.
 */

export const MAX_EVIDENCE = 2000;

/** A paper's confirmed authors, by their printed names, in the paper's order. **Public:** no account ids. */
export async function confirmedAuthors(
  paperId: string,
  database: Database = getDb(),
): Promise<{ authorIndex: number; authorName: string }[]> {
  return database
    .select({ authorIndex: authorClaims.authorIndex, authorName: authorClaims.authorName })
    .from(authorClaims)
    .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.status, 'confirmed')))
    .orderBy(asc(authorClaims.authorIndex));
}

export interface OwnClaim {
  authorIndex: number;
  authorName: string;
  status: ClaimStatus;
  evidence: string;
}

/** The account's own claim on the paper, if it has made one. */
export async function ownClaim(
  paperId: string,
  accountId: string,
  database: Database = getDb(),
): Promise<OwnClaim | null> {
  const [row] = await database
    .select({
      authorIndex: authorClaims.authorIndex,
      authorName: authorClaims.authorName,
      status: authorClaims.status,
      evidence: authorClaims.evidence,
    })
    .from(authorClaims)
    .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.accountId, accountId)));
  return row ?? null;
}

/**
 * Asks to be confirmed as one of the paper's authors. A pending claim can be changed by asking again; a
 * decided one can't.
 */
export async function requestClaim(
  paperId: string,
  account: Account,
  input: { authorIndex: number; evidence: string },
  database: Database = getDb(),
): Promise<OwnClaim> {
  if (!account.verifiedAt && !account.isBot) {
    throw new ApiError(403, 'forbidden', 'confirm an institutional email address first');
  }
  if (account.isBot) throw new ApiError(403, 'forbidden', 'a bot cannot be an author');
  const [paper] = await database.select({ authors: papers.authors }).from(papers).where(eq(papers.id, paperId));
  if (!paper) throw new ApiError(404, 'not_found', 'no such paper');
  const authorName = paper.authors[input.authorIndex];
  if (authorName === undefined) throw new ApiError(422, 'validation_error', 'that author is not on the paper');
  const evidence = input.evidence.trim().slice(0, MAX_EVIDENCE);

  const [taken] = await database
    .select({ accountId: authorClaims.accountId })
    .from(authorClaims)
    .where(
      and(
        eq(authorClaims.paperId, paperId),
        eq(authorClaims.authorIndex, input.authorIndex),
        eq(authorClaims.status, 'confirmed'),
      ),
    );
  if (taken && taken.accountId !== account.id) {
    throw new ApiError(409, 'claim_taken', `${authorName} is already a confirmed author of this paper`);
  }

  const existing = await ownClaim(paperId, account.id, database);
  if (existing && existing.status !== 'pending') {
    throw new ApiError(409, 'claim_decided', `your claim was already ${existing.status}`);
  }
  if (existing) {
    await database
      .update(authorClaims)
      .set({ authorIndex: input.authorIndex, authorName, evidence })
      .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.accountId, account.id)));
  } else {
    try {
      await database.insert(authorClaims).values({
        paperId,
        accountId: account.id,
        authorIndex: input.authorIndex,
        authorName,
        evidence,
        identityId: newIdentity('a'),
      });
    } catch (err) {
      if (pgErrorCode(err) === '23505') throw new ApiError(503, 'page_busy', 'could not record the claim; try again');
      throw err;
    }
  }
  return { authorIndex: input.authorIndex, authorName, status: 'pending', evidence };
}

/** Takes back a claim that hasn't been decided. */
export async function withdrawClaim(paperId: string, accountId: string, database: Database = getDb()): Promise<void> {
  const removed = await database
    .delete(authorClaims)
    .where(
      and(eq(authorClaims.paperId, paperId), eq(authorClaims.accountId, accountId), eq(authorClaims.status, 'pending')),
    )
    .returning({ id: authorClaims.id });
  if (removed.length === 0) throw new ApiError(404, 'not_found', 'you have no pending claim on this paper');
}

/** An admin's decision. Confirming fails if someone else is already confirmed as that author. */
export async function decideClaim(
  claimId: string,
  status: 'confirmed' | 'rejected',
  decidedBy: string | null,
  database: Database = getDb(),
): Promise<AuthorClaim> {
  try {
    const [row] = await database
      .update(authorClaims)
      .set({ status, decidedBy, decidedAt: new Date() })
      .where(eq(authorClaims.id, claimId))
      .returning();
    if (!row) throw new ApiError(404, 'not_found', 'no such claim');
    return row;
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      throw new ApiError(409, 'claim_taken', 'someone else is already confirmed as that author');
    }
    throw err;
  }
}

/** Claims waiting for a decision, oldest first, with who made them. For admins only. */
export async function pendingClaims(database: Database = getDb()) {
  return database
    .select({
      id: authorClaims.id,
      paperId: authorClaims.paperId,
      title: papers.title,
      authorName: authorClaims.authorName,
      evidence: authorClaims.evidence,
      handle: accounts.handle,
      realName: accounts.realName,
      institutions: accounts.institutions,
      createdAt: authorClaims.createdAt,
    })
    .from(authorClaims)
    .innerJoin(papers, eq(papers.id, authorClaims.paperId))
    .innerJoin(accounts, eq(accounts.id, authorClaims.accountId))
    .where(eq(authorClaims.status, 'pending'))
    .orderBy(asc(authorClaims.createdAt));
}

/** The printed names behind per-claim identities. **Public:** only the name crosses. */
export async function claimNames(identityIds: readonly string[], database: Database = getDb()) {
  const ids = [...new Set(identityIds)].filter((id) => id.startsWith('a_'));
  if (ids.length === 0) return new Map<string, string>();
  const rows = await database
    .select({ id: authorClaims.identityId, name: authorClaims.authorName })
    .from(authorClaims)
    .where(inArray(authorClaims.identityId, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Whether the paper is claimed, and whether this account is one of its confirmed authors. */
export async function claimRoles(
  paperId: string,
  accountId: string | null,
  database: Database = getDb(),
): Promise<{ claimed: boolean; confirmedAuthor: boolean }> {
  const rows = await database
    .select({ accountId: authorClaims.accountId })
    .from(authorClaims)
    .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.status, 'confirmed')));
  return { claimed: rows.length > 0, confirmedAuthor: rows.some((row) => row.accountId === accountId) };
}
