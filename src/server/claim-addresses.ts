import { timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { isUniqueViolation } from '@/db/errors';
import { accountEmails, affiliations, papers, type Account } from '@/db/schema';
import { claimCodeMail } from '@/lib/claim-mails';
import {
  addAffiliation,
  hashCode,
  MAIL_BUDGET,
  MAX_CODE_ATTEMPTS,
  MAX_PENDING,
  newCode,
  normalizeEmail,
  verifyAffiliation,
} from './affiliations';
import { ApiError } from './api/errors';
import { claimByEmail, CONFIRMED_ADDRESSES, ownClaim, requestClaim, type OwnClaim } from './claims';
import { institutionForEmail } from './institution-domains';
import { sendMail } from './mail';
import { summaries } from './my-papers';
import { paperAddresses } from './claim-requests';
import { consume, rateLimitHeaders } from './ratelimit';
import { siteUrl } from './site';

/**
 * Claiming a paper by an address printed on it that the account hasn't confirmed yet (DESIGN.md §6): the claim is
 * made pending as the author they pick, a code goes to the address, and typing it back confirms the address, which
 * confirms the claim (`claimByEmail`). An institutional address becomes an affiliation (`affiliations.ts`); any
 * other becomes one of the account's other addresses (`account_emails`), which proves authorship but no institution.
 *
 * Only an address on the paper's current PDF can be sent a code, so this mails no one else.
 */

const CODE_TTL_MS = 60 * 60 * 1000;

/** Whether another account has confirmed `email`, by any route. */
async function takenElsewhere(email: string, accountId: string, database: Database): Promise<boolean> {
  const { rows } = await database.execute(
    sql`select 1 from (${CONFIRMED_ADDRESSES}) o where o.email = ${email} and o.account_id <> ${accountId} limit 1`,
  );
  return rows.length > 0;
}

/**
 * Claims to be author `authorIndex`, and sends a code to `email`, which must be printed on the paper. With the
 * address already confirmed by the account, the claim is confirmed at once and nothing is sent.
 */
export async function sendClaimCode(
  paperId: string,
  account: Account,
  input: { authorIndex: number; email: string },
  database: Database = getDb(),
): Promise<{ claim: OwnClaim; sent: boolean }> {
  const email = normalizeEmail(input.email);
  const { emails } = await paperAddresses(paperId, database);
  if (!emails.includes(email)) throw new ApiError(422, 'validation_error', 'that address is not printed on this paper');
  if (await takenElsewhere(email, account.id, database)) {
    throw new ApiError(409, 'affiliation_taken', 'another account has confirmed this address');
  }
  const before = await ownClaim(paperId, account.id, database);
  const claim = await requestClaim(
    paperId,
    account,
    { authorIndex: input.authorIndex, evidence: before?.status === 'pending' ? before.evidence : '' },
    database,
  );
  if (claim.status === 'confirmed') return { claim, sent: false };

  const [paper] = await database.select({ title: papers.title }).from(papers).where(eq(papers.id, paperId));
  const [summary] = (await summaries([paperId], database)).values();
  const mail = (code: string) =>
    claimCodeMail({
      code,
      title: paper?.title ?? '',
      authorName: claim.authorName,
      claimUrl: `${siteUrl()}${summary ? `/claim${summary.path}` : '/claim'}`,
    });

  if (await institutionForEmail(email, database)) {
    await addAffiliation({ account, email }, database, mail);
    return { claim, sent: true };
  }

  const budget = await consume(`affiliation-mail:${account.id}`, MAIL_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many codes sent; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
  const code = newCode();
  const codeFields = { codeHash: hashCode(code), codeExpiresAt: new Date(Date.now() + CODE_TTL_MS), codeAttempts: 0 };
  const [mine] = await database
    .select()
    .from(accountEmails)
    .where(and(eq(accountEmails.accountId, account.id), eq(accountEmails.email, email)));
  if (mine) {
    await database.update(accountEmails).set(codeFields).where(eq(accountEmails.id, mine.id));
  } else {
    const [{ pending }] = await database
      .select({ pending: sql<number>`count(*)::int` })
      .from(accountEmails)
      .where(and(eq(accountEmails.accountId, account.id), isNull(accountEmails.verifiedAt)));
    if (pending >= MAX_PENDING) {
      throw new ApiError(409, 'too_many_pending', 'too many unconfirmed addresses; confirm one first');
    }
    await database.insert(accountEmails).values({ accountId: account.id, email, ...codeFields });
  }
  await sendMail({ to: email, ...mail(code) });
  return { claim, sent: true };
}

/** Confirms an address the account was sent a code for (`sendClaimCode`), which confirms its claims it proves. */
export async function confirmClaimCode(
  accountId: string,
  input: { email: string; code: string },
  database: Database = getDb(),
): Promise<void> {
  const email = normalizeEmail(input.email);
  const [affiliation] = await database
    .select({ id: affiliations.id })
    .from(affiliations)
    .where(and(eq(affiliations.accountId, accountId), eq(affiliations.email, email)));
  if (affiliation) {
    await verifyAffiliation({ accountId, id: affiliation.id, code: input.code }, database);
    return;
  }

  const [row] = await database
    .select()
    .from(accountEmails)
    .where(and(eq(accountEmails.accountId, accountId), eq(accountEmails.email, email)));
  if (!row) throw new ApiError(404, 'not_found', 'no code was sent to that address; send one first');
  if (!row.verifiedAt) {
    const failure =
      !row.codeHash || !row.codeExpiresAt
        ? 'no code is outstanding for this address; send a new one'
        : row.codeAttempts >= MAX_CODE_ATTEMPTS
          ? 'too many wrong codes; send a new one'
          : row.codeExpiresAt.getTime() <= Date.now()
            ? 'that code has expired; send a new one'
            : null;
    if (failure) throw new ApiError(422, 'invalid_code', failure);
    const given = Buffer.from(hashCode(input.code.trim()), 'hex');
    if (!timingSafeEqual(given, Buffer.from(row.codeHash!, 'hex'))) {
      await database
        .update(accountEmails)
        .set({ codeAttempts: sql`${accountEmails.codeAttempts} + 1` })
        .where(eq(accountEmails.id, row.id));
      throw new ApiError(422, 'invalid_code', 'that code is not right');
    }
    if (await takenElsewhere(email, accountId, database)) {
      throw new ApiError(409, 'affiliation_taken', 'another account has confirmed this address');
    }
    try {
      await database
        .update(accountEmails)
        .set({ verifiedAt: sql`clock_timestamp()`, codeHash: null, codeExpiresAt: null, codeAttempts: 0 })
        .where(eq(accountEmails.id, row.id));
    } catch (err) {
      if (isUniqueViolation(err))
        throw new ApiError(409, 'affiliation_taken', 'another account has confirmed this address');
      throw err;
    }
  }
  await claimByEmail({ accountId }, database);
}

/** The account's other addresses, confirmed or waiting for a code: for its profile. **Private.** */
export async function otherAddresses(accountId: string, database: Database = getDb()) {
  return database
    .select({ id: accountEmails.id, email: accountEmails.email, verifiedAt: accountEmails.verifiedAt })
    .from(accountEmails)
    .where(eq(accountEmails.accountId, accountId))
    .orderBy(accountEmails.createdAt);
}
