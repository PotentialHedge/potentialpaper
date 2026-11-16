import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pgErrorCode } from '@/db/errors';
import {
  accounts,
  authorClaims,
  paperFollows,
  paperIdentifiers,
  papers,
  type Account,
  type AuthorClaim,
  type ClaimMethod,
  type ClaimStatus,
  type ClaimVerification,
} from '@/db/schema';
import { ApiError } from './api/errors';
import { newIdentity } from './pages/commit';
import { refreshPaperPages } from './pages/refresh';
import { authorsForEmails } from './pdfs/authors';

/**
 * Claims of authorship (DESIGN.md §6). A paper is claimed once one of its printed authors has a confirmed
 * claim, and unclaimed until then. A claim names which author the account says it is, with the evidence
 * in their own words. It is decided by one of the design's routes, recorded in `method`:
 *
 * - **`email`, automatic:** one of the account's confirmed addresses (an affiliation, or the sign-up address)
 *   is among the emails on the first page of the paper's current PDF (`pdf_documents.emails`, from
 *   `server/pdfs/ingest.ts`). When the page also says unambiguously which printed author the address is
 *   (`server/pdfs/authors.ts`), the account is made that author with no claim at all; otherwise it
 *   claims, picking the author, and is confirmed at once. `claimByEmail` does both, when an account is
 *   created, when it confirms an address, and when ingest reads a PDF. An automatic author can take it
 *   back (`withdrawClaim`), which leaves the claim `declined` so it isn't made again.
 * - **`manual`:** everything else waits for an admin (`scripts/decide-claim.ts`).
 * - **`vouch`:** a confirmed author adds a co-author (`addCoAuthor`, from My papers): names their account by
 *   handle and which printed author they are, or confirms a claim they are waiting on. It is confirmed at
 *   once, and they can step down from it as from an automatic one.
 *
 * **The PDF's emails are private.** Nothing here returns them, or says which address matched, to anyone but
 * the account itself, and only its own addresses (`ownAddressesOnPaper`).
 */

export const MAX_EVIDENCE = 2000;

/** A newly confirmed author changes the paper's page ("maintained by", who may edit its card). */
async function refreshPaper(paperId: string, database: Database): Promise<void> {
  const identifiers = await database
    .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, paperId));
  await refreshPaperPages(identifiers);
}

/** Authors follow their own papers (`server/follows.ts`): called wherever a claim becomes confirmed. */
async function followAsAuthor(paperId: string, accountId: string, database: Database): Promise<void> {
  await database.insert(paperFollows).values({ paperId, accountId }).onConflictDoNothing();
}

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
  method: ClaimMethod;
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
      method: authorClaims.method,
      evidence: authorClaims.evidence,
    })
    .from(authorClaims)
    .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.accountId, accountId)));
  return row ?? null;
}

/**
 * Each pair of an account and a paper, among those `where` selects, with a confirmed address of the
 * account printed on the first page of the paper's current PDF: the address and the PDF. `where` sees
 * `ac.account_id`, `ac.paper_id` and `d.sha256`, through the `pairs` it is given.
 */
function addressMatches(pairs: SQL, where: SQL = sql`true`): SQL {
  return sql`
    select distinct on (ac.account_id, ac.paper_id) ac.account_id, ac.paper_id, m.email, d.sha256
    from (${pairs}) ac
    join page_current c on c.page_id = ac.paper_id
    join pdf_documents d on d.sha256 = c.pdf ->> 'sha256'
    cross join lateral (
      select f.email from affiliations f
       where f.account_id = ac.account_id and f.verified_at is not null and f.email = any(d.emails)
      union all
      select lower(u.email) from accounts a join "user" u on u.id = a.user_id
       where a.id = ac.account_id and u.email_verified and lower(u.email) = any(d.emails)
    ) m
    where ${where}
    order by ac.account_id, ac.paper_id, m.email
  `;
}

/** The address and PDF that confirm this account as an author of the paper, if any does. **Private.** */
async function emailEvidence(
  paperId: string,
  accountId: string,
  database: Database,
): Promise<ClaimVerification | null> {
  const { rows } = await database.execute<{ email: string; sha256: string }>(
    addressMatches(sql`select ${accountId}::uuid as account_id, ${paperId}::uuid as paper_id`),
  );
  return rows[0] ? { email: rows[0].email, sha256: rows[0].sha256 } : null;
}

/**
 * Which of the account's **own** confirmed addresses are printed on the paper's first page, for the claim
 * page to tell them that claiming will be confirmed at once. Never any other address on the PDF.
 */
export async function ownAddressesOnPaper(
  paperId: string,
  accountId: string,
  database: Database = getDb(),
): Promise<{ onPaper: string[]; hasPdfEmails: boolean; own: string[] }> {
  const { rows } = await database.execute<{ email: string; on_paper: boolean; has_pdf_emails: boolean }>(sql`
    with pdf as (
      select d.emails from page_current c join pdf_documents d on d.sha256 = c.pdf ->> 'sha256'
       where c.page_id = ${paperId}
    ), own as (
      select f.email from affiliations f where f.account_id = ${accountId} and f.verified_at is not null
      union
      select lower(u.email) from accounts a join "user" u on u.id = a.user_id
       where a.id = ${accountId} and u.email_verified
    )
    select own.email,
           coalesce(own.email = any(pdf.emails), false) as on_paper,
           coalesce(cardinality(pdf.emails) > 0, false) as has_pdf_emails
    from own left join pdf on true
    order by own.email
  `);
  return {
    own: rows.map((r) => r.email),
    onPaper: rows.filter((r) => r.on_paper).map((r) => r.email),
    hasPdfEmails: rows.some((r) => r.has_pdf_emails),
  };
}

/**
 * Asks to be confirmed as one of the paper's authors. With a confirmed address on the paper's first page
 * the claim is confirmed at once (`method: 'email'`); otherwise it waits for an admin. A pending claim can
 * be changed by asking again; a decided one can't.
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
  if (existing && existing.status !== 'pending' && existing.status !== 'declined') {
    throw new ApiError(409, 'claim_decided', `your claim was already ${existing.status}`);
  }
  const verification = await emailEvidence(paperId, account.id, database);
  const decision = verification
    ? { status: 'confirmed' as const, method: 'email' as const, verification, decidedAt: new Date() }
    : { status: 'pending' as const, method: 'manual' as const, verification: null, decidedAt: null };
  try {
    if (existing) {
      await database
        .update(authorClaims)
        .set({ authorIndex: input.authorIndex, authorName, evidence, ...decision })
        .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.accountId, account.id)));
    } else {
      await database.insert(authorClaims).values({
        paperId,
        accountId: account.id,
        authorIndex: input.authorIndex,
        authorName,
        evidence,
        identityId: newIdentity('a'),
        ...decision,
      });
    }
  } catch (err) {
    if (pgErrorCode(err) !== '23505') throw err;
    // Someone was confirmed as this author since the check above, or the insert raced another.
    if (verification)
      throw new ApiError(409, 'claim_taken', `${authorName} is already a confirmed author of this paper`);
    throw new ApiError(503, 'page_busy', 'could not record the claim; try again');
  }
  if (verification) {
    await followAsAuthor(paperId, account.id, database);
    await refreshPaper(paperId, database);
  }
  return { authorIndex: input.authorIndex, authorName, status: decision.status, method: decision.method, evidence };
}

/**
 * Confirms each pending claim, among those selected, whose account has a confirmed address on the paper's
 * first page: after an account confirms an address (`accountId`), or ingest finds new emails on a PDF
 * (`sha256`). A claim whose author someone else is already confirmed as stays pending, for an admin.
 * Returns how many it confirmed.
 */
export async function recheckPendingClaims(
  scope: { accountId?: string; sha256?: string },
  database: Database = getDb(),
): Promise<number> {
  const filters: SQL[] = [sql`true`];
  if (scope.accountId) filters.push(sql`ac.account_id = ${scope.accountId}`);
  if (scope.sha256) filters.push(sql`d.sha256 = ${scope.sha256}`);
  const { rows } = await database.execute<{ account_id: string; paper_id: string; email: string; sha256: string }>(
    addressMatches(
      sql`select account_id, paper_id from author_claims where status = 'pending'`,
      sql.join(filters, sql` and `),
    ),
  );
  let confirmed = 0;
  for (const row of rows) {
    try {
      const updated = await database
        .update(authorClaims)
        .set({
          status: 'confirmed',
          method: 'email',
          verification: { email: row.email, sha256: row.sha256 },
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(authorClaims.paperId, row.paper_id),
            eq(authorClaims.accountId, row.account_id),
            eq(authorClaims.status, 'pending'),
          ),
        )
        .returning({ id: authorClaims.id });
      confirmed += updated.length;
      if (updated.length > 0) {
        await followAsAuthor(row.paper_id, row.account_id, database);
        await refreshPaper(row.paper_id, database);
      }
    } catch (err) {
      if (pgErrorCode(err) !== '23505') throw err;
    }
  }
  return confirmed;
}

/**
 * Everything an address on a first page does, for the accounts and PDFs selected: confirms pending claims
 * (`recheckPendingClaims`), and makes each verified account with no claim on a paper that paper's author,
 * where its address says which printed author it is (`server/pdfs/authors.ts`). Never takes an author
 * someone is already confirmed as. Returns how many claims it confirmed or made.
 */
export async function claimByEmail(
  scope: { accountId?: string; sha256?: string },
  database: Database = getDb(),
): Promise<number> {
  let count = await recheckPendingClaims(scope, database);
  const filters: SQL[] = [sql`true`];
  if (scope.accountId) filters.push(sql`a.id = ${scope.accountId}`);
  if (scope.sha256) filters.push(sql`d.sha256 = ${scope.sha256}`);
  const { rows } = await database.execute<{
    account_id: string;
    paper_id: string;
    email: string;
    sha256: string;
    emails: string[];
    first_page_raw: string | null;
    authors: string[];
  }>(sql`
    select distinct on (a.id, c.page_id, own.email)
           a.id as account_id, c.page_id as paper_id, own.email, d.sha256, d.emails, d.first_page_raw, p.authors
    from (
      select f.account_id, f.email from affiliations f where f.verified_at is not null
      union
      select a.id, lower(u.email) from accounts a join "user" u on u.id = a.user_id where u.email_verified
    ) own
    join accounts a on a.id = own.account_id and a.verified_at is not null and not a.is_bot
    join pdf_documents d on own.email = any(d.emails)
    join page_current c on c.pdf ->> 'sha256' = d.sha256
    join papers p on p.id = c.page_id
    where ${sql.join(filters, sql` and `)}
      and not exists (select from author_claims ac where ac.paper_id = c.page_id and ac.account_id = a.id)
  `);
  for (const row of rows) {
    const authorIndex = authorsForEmails(row.emails, row.authors, row.first_page_raw ?? '').get(row.email);
    if (authorIndex === undefined) continue;
    try {
      const made = await database
        .insert(authorClaims)
        .values({
          paperId: row.paper_id,
          accountId: row.account_id,
          authorIndex,
          authorName: row.authors[authorIndex],
          status: 'confirmed',
          method: 'email',
          verification: { email: row.email, sha256: row.sha256 },
          decidedAt: new Date(),
          identityId: newIdentity('a'),
        })
        .onConflictDoNothing()
        .returning({ id: authorClaims.id });
      if (made.length > 0) {
        count += 1;
        await followAsAuthor(row.paper_id, row.account_id, database);
        await refreshPaper(row.paper_id, database);
      }
    } catch (err) {
      // `onConflictDoNothing` covers a claim made meanwhile; this is someone confirmed as that author.
      if (pgErrorCode(err) !== '23505') throw err;
    }
  }
  return count;
}

/** The ways a claim is confirmed without an admin, which the author may step down from. */
const STEP_DOWN_METHODS: ClaimMethod[] = ['email', 'vouch'];

/** Whether the account can step down from this claim (`withdrawClaim`) rather than only an admin undoing it. */
export function canStepDown(claim: { status: ClaimStatus; method: ClaimMethod }): boolean {
  return claim.status === 'confirmed' && STEP_DOWN_METHODS.includes(claim.method);
}

/**
 * Takes back a claim that hasn't been decided, or steps down as an author the site made without an admin
 * (`method: 'email'` or `'vouch'`), which is kept as `declined` so it isn't made again. An admin's decision stays.
 */
export async function withdrawClaim(paperId: string, accountId: string, database: Database = getDb()): Promise<void> {
  const mine = and(eq(authorClaims.paperId, paperId), eq(authorClaims.accountId, accountId));
  const removed = await database
    .delete(authorClaims)
    .where(and(mine, eq(authorClaims.status, 'pending')))
    .returning({ id: authorClaims.id });
  if (removed.length > 0) return;
  const declined = await database
    .update(authorClaims)
    .set({ status: 'declined', decidedAt: new Date() })
    .where(and(mine, eq(authorClaims.status, 'confirmed'), inArray(authorClaims.method, STEP_DOWN_METHODS)))
    .returning({ id: authorClaims.id });
  if (declined.length === 0) throw new ApiError(404, 'not_found', 'you have no claim on this paper to take back');
  await refreshPaper(paperId, database);
}

/** Who a co-author is: their handle and which printed author they are, or the pending claim they made. */
export type CoAuthorTarget = { handle: string; authorIndex: number } | { claimId: string };

/**
 * A confirmed author vouches for a co-author (`method: 'vouch'`, DESIGN.md §6): confirms them at once as one of
 * the paper's printed authors, by their account's handle, or confirms a claim they made and are waiting on.
 * Never over a decision: not someone an admin rejected, nor one who stepped down (they can claim again), nor an
 * author someone is already confirmed as.
 */
export async function addCoAuthor(
  paperId: string,
  voucher: Account,
  target: CoAuthorTarget,
  database: Database = getDb(),
): Promise<{ accountId: string; authorIndex: number; authorName: string }> {
  const { owner } = await claimRoles(paperId, voucher.id, database);
  if (!owner) throw new ApiError(403, 'forbidden', 'only a confirmed author of the paper can add a co-author');
  const [paper] = await database.select({ authors: papers.authors }).from(papers).where(eq(papers.id, paperId));
  if (!paper) throw new ApiError(404, 'not_found', 'no such paper');

  let accountId: string;
  let authorIndex: number;
  if ('claimId' in target) {
    const [claim] = await database
      .select({ accountId: authorClaims.accountId, authorIndex: authorClaims.authorIndex })
      .from(authorClaims)
      .where(
        and(eq(authorClaims.id, target.claimId), eq(authorClaims.paperId, paperId), eq(authorClaims.status, 'pending')),
      );
    if (!claim) throw new ApiError(404, 'not_found', 'no such claim waiting on this paper');
    ({ accountId, authorIndex } = claim);
  } else {
    const handle = target.handle.trim().replace(/^@/, '').toLowerCase();
    const [account] = await database
      .select({ id: accounts.id, isBot: accounts.isBot, verifiedAt: accounts.verifiedAt })
      .from(accounts)
      .where(eq(accounts.handle, handle));
    if (!account) throw new ApiError(404, 'not_found', `nobody has the handle @${handle}`);
    if (account.isBot) throw new ApiError(422, 'validation_error', 'a bot cannot be an author');
    if (!account.verifiedAt) {
      throw new ApiError(422, 'not_verified', `@${handle} has to confirm an institutional address first`);
    }
    accountId = account.id;
    authorIndex = target.authorIndex;
  }
  if (accountId === voucher.id) throw new ApiError(422, 'validation_error', 'you are already an author of this paper');
  const authorName = paper.authors[authorIndex];
  if (authorName === undefined) throw new ApiError(422, 'validation_error', 'that author is not on the paper');

  const existing = await ownClaim(paperId, accountId, database);
  if (existing?.status === 'confirmed') {
    throw new ApiError(409, 'claim_taken', `they are already a confirmed author, as ${existing.authorName}`);
  }
  if (existing?.status === 'rejected') {
    throw new ApiError(409, 'claim_decided', 'an admin turned down their claim on this paper');
  }
  if (existing?.status === 'declined') {
    throw new ApiError(409, 'claim_decided', 'they stepped down from this paper; they can claim it again themselves');
  }
  const decision = {
    authorIndex,
    authorName,
    status: 'confirmed' as const,
    method: 'vouch' as const,
    verification: null,
    decidedBy: voucher.id,
    decidedAt: new Date(),
  };
  try {
    if (existing) {
      const updated = await database
        .update(authorClaims)
        .set(decision)
        .where(
          and(
            eq(authorClaims.paperId, paperId),
            eq(authorClaims.accountId, accountId),
            eq(authorClaims.status, 'pending'),
          ),
        )
        .returning({ id: authorClaims.id });
      if (updated.length === 0) throw new ApiError(503, 'page_busy', 'their claim changed meanwhile; try again');
    } else {
      await database
        .insert(authorClaims)
        .values({ paperId, accountId, evidence: '', identityId: newIdentity('a'), ...decision });
    }
  } catch (err) {
    if (pgErrorCode(err) !== '23505') throw err;
    throw new ApiError(409, 'claim_taken', `someone is already confirmed as ${authorName}, or claimed meanwhile`);
  }
  await followAsAuthor(paperId, accountId, database);
  await refreshPaper(paperId, database);
  return { accountId, authorIndex, authorName };
}

/** An admin's decision (`method: 'manual'`). Confirming fails if someone else is already confirmed as that author. */
export async function decideClaim(
  claimId: string,
  status: 'confirmed' | 'rejected',
  decidedBy: string | null,
  database: Database = getDb(),
): Promise<AuthorClaim> {
  try {
    const [row] = await database
      .update(authorClaims)
      .set({ status, method: 'manual', verification: null, decidedBy, decidedAt: new Date() })
      .where(eq(authorClaims.id, claimId))
      .returning();
    if (!row) throw new ApiError(404, 'not_found', 'no such claim');
    if (row.status === 'confirmed') await followAsAuthor(row.paperId, row.accountId, database);
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
): Promise<{ claimed: boolean; owner: boolean }> {
  const rows = await database
    .select({ accountId: authorClaims.accountId })
    .from(authorClaims)
    .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.status, 'confirmed')));
  return { claimed: rows.length > 0, owner: rows.some((row) => row.accountId === accountId) };
}
