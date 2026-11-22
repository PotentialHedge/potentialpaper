import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { accounts, authorClaims, papers, type Account } from '@/db/schema';
import { claimDeniedMail, claimRequestMail } from '@/lib/claim-mails';
import { ApiError } from './api/errors';
import { claimRoles, confirmedAddresses, CONFIRMED_ADDRESSES, requestClaim, type OwnClaim } from './claims';
import { sendMail } from './mail';
import { summaries, type PaperSummary } from './my-papers';
import { authorsForEmails } from './pdfs/authors';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './site';

/**
 * Claiming without an address of one's own on the paper (DESIGN.md §6): asking its confirmed co-authors, who are
 * mailed and confirm (`addCoAuthor`) or deny (`denyClaim`) on My papers, the first answer deciding; and finding
 * one's papers to claim (`claimSuggestions`). A co-author confirmed later is mailed about claims still waiting
 * (`notifyWaitingClaims`). Whatever no co-author answers, an admin can (`scripts/decide-claim.ts`).
 */

/**
 * The addresses printed on the paper's current PDF, and which printed author each belongs to where that is clear
 * (`pdfs/authors.ts`). They are on a public PDF, so they are shown to someone claiming the paper.
 */
export async function paperAddresses(
  paperId: string,
  database: Database = getDb(),
): Promise<{ emails: string[]; authorOf: Record<string, number> }> {
  const { rows } = await database.execute<{ emails: string[]; first_page_raw: string | null; authors: string[] }>(sql`
    select d.emails, d.first_page_raw, p.authors
      from page_current c
      join pdf_documents d on d.sha256 = c.pdf ->> 'sha256'
      join papers p on p.id = c.page_id
     where c.page_id = ${paperId}
  `);
  const row = rows[0];
  if (!row) return { emails: [], authorOf: {} };
  const authorOf = Object.fromEntries(authorsForEmails(row.emails, row.authors, row.first_page_raw ?? ''));
  return { emails: row.emails, authorOf };
}

/** Asks per account: 10, refilling over a day. Each one mails every confirmed co-author. */
const ASK_BUDGET: RateLimitConfig = { burst: 10, perSecond: 10 / 86_400 };

/** Each confirmed author of the paper but `except`, with the address their mail goes to. */
async function confirmedAuthorMail(paperId: string, except: string, database: Database) {
  return database
    .select({ accountId: authorClaims.accountId, authorName: authorClaims.authorName, email: user.email })
    .from(authorClaims)
    .innerJoin(accounts, eq(accounts.id, authorClaims.accountId))
    .innerJoin(user, eq(user.id, accounts.userId))
    .where(
      and(
        eq(authorClaims.paperId, paperId),
        eq(authorClaims.status, 'confirmed'),
        ne(authorClaims.accountId, except),
        eq(user.emailVerified, true),
        eq(accounts.isBot, false),
      ),
    )
    .orderBy(asc(authorClaims.authorIndex));
}

/**
 * Claims to be author `authorIndex` and mails the paper's confirmed co-authors to confirm it. They see the claimant's
 * confirmed addresses and note. With nobody confirmed yet, the claim waits for the first co-author to join
 * (`notifyWaitingClaims`). Returns the claim, and the printed names of the authors asked.
 */
export async function askCoAuthors(
  paperId: string,
  account: Account,
  input: { authorIndex: number; evidence: string },
  database: Database = getDb(),
): Promise<{ claim: OwnClaim; asked: string[] }> {
  const budget = await consume(`claim-ask:${account.id}`, ASK_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many requests to co-authors; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
  const claim = await requestClaim(paperId, account, input, database);
  if (claim.status !== 'pending') return { claim, asked: [] };
  const authors = await confirmedAuthorMail(paperId, account.id, database);
  await mailRequest(paperId, account.id, claim, authors, database);
  return { claim, asked: authors.map((a) => a.authorName) };
}

async function mailRequest(
  paperId: string,
  claimantId: string,
  claim: { authorName: string; evidence: string },
  to: { email: string }[],
  database: Database,
): Promise<void> {
  if (to.length === 0) return;
  const [[paper], addresses] = await Promise.all([
    database.select({ title: papers.title }).from(papers).where(eq(papers.id, paperId)),
    confirmedAddresses(claimantId, database),
  ]);
  const mail = claimRequestMail({
    authorName: claim.authorName,
    title: paper?.title ?? '',
    addresses,
    note: claim.evidence,
    papersUrl: `${siteUrl()}/papers`,
  });
  for (const { email } of to) await sendMail({ to: email, ...mail });
}

/**
 * A newly confirmed author of the paper hears of the claims by others waiting on it, so that a co-author who joins
 * after being asked still gets asked. Called wherever a claim becomes confirmed; never throws.
 */
export async function notifyWaitingClaims(paperId: string, accountId: string, database: Database = getDb()) {
  try {
    const waiting = await database
      .select({
        accountId: authorClaims.accountId,
        authorName: authorClaims.authorName,
        evidence: authorClaims.evidence,
      })
      .from(authorClaims)
      .where(
        and(
          eq(authorClaims.paperId, paperId),
          eq(authorClaims.status, 'pending'),
          ne(authorClaims.accountId, accountId),
        ),
      );
    if (waiting.length === 0) return;
    const [me] = await database
      .select({ email: user.email })
      .from(accounts)
      .innerJoin(user, eq(user.id, accounts.userId))
      .where(and(eq(accounts.id, accountId), eq(user.emailVerified, true), eq(accounts.isBot, false)));
    if (!me) return;
    for (const claim of waiting) await mailRequest(paperId, claim.accountId, claim, [me], database);
  } catch (err) {
    console.error('waiting-claims mail failed', err);
  }
}

/**
 * A confirmed author says a pending claim on their paper is not who it says (`method: 'vouch'`, `rejected`). The
 * first answer decides: a claim already confirmed or denied is left as it is. The claimant is told.
 */
export async function denyClaim(
  paperId: string,
  voucher: Account,
  claimId: string,
  database: Database = getDb(),
): Promise<void> {
  const { owner } = await claimRoles(paperId, voucher.id, database);
  if (!owner) throw new ApiError(403, 'forbidden', 'only a confirmed author of the paper can answer a claim');
  const [denied] = await database
    .update(authorClaims)
    .set({ status: 'rejected', method: 'vouch', verification: null, decidedBy: voucher.id, decidedAt: new Date() })
    .where(and(eq(authorClaims.id, claimId), eq(authorClaims.paperId, paperId), eq(authorClaims.status, 'pending')))
    .returning({ accountId: authorClaims.accountId, authorName: authorClaims.authorName });
  if (!denied)
    throw new ApiError(404, 'not_found', 'no such claim waiting on this paper; a co-author may have answered');

  const [claimant] = await database
    .select({ email: user.email })
    .from(accounts)
    .innerJoin(user, eq(user.id, accounts.userId))
    .where(and(eq(accounts.id, denied.accountId), eq(user.emailVerified, true)));
  const [summary] = (await summaries([paperId], database)).values();
  if (!claimant || !summary) return;
  await sendMail({
    to: claimant.email,
    ...claimDeniedMail({ authorName: denied.authorName, title: summary.title, url: `${siteUrl()}${summary.path}` }),
  }).catch((err) => console.error('claim-denied mail failed', err));
}

/** The names the account is, or asked to be, an author under, as printed. **Private** to the account. */
export async function claimedNames(accountId: string, database: Database = getDb()): Promise<string[]> {
  const rows = await database
    .selectDistinct({ name: authorClaims.authorName })
    .from(authorClaims)
    .where(and(eq(authorClaims.accountId, accountId), inArray(authorClaims.status, ['confirmed', 'pending'])))
    .orderBy(asc(authorClaims.authorName));
  return rows.map((r) => r.name);
}

export interface ClaimSuggestion extends PaperSummary {
  authors: string[];
  /** One of the account's confirmed addresses is on the paper's first page: claiming confirms at once. */
  byEmail: boolean;
  /** Which author the account most likely is: by its address on the page, or by a name it has claimed under. */
  likely: number | null;
  /** Authors someone is confirmed as. */
  taken: number[];
  /** The account's own claim, if any. */
  mine: { authorIndex: number; status: string } | null;
}

export const SUGGESTION_LIMIT = 30;

/**
 * Papers the account may have written, most likely first: those with one of its addresses on the first page, then
 * those printing a name it has claimed under. With `q`, only papers whose title, abstract or authors match it, in
 * the same order and then by relevance. Papers it is already confirmed on come last.
 */
export async function claimSuggestions(
  accountId: string,
  q: string | null,
  database: Database = getDb(),
): Promise<ClaimSuggestion[]> {
  const query = q?.trim().slice(0, 200) || null;
  const names = await claimedNames(accountId, database);
  const namesArray = sql`${`{${names.map((n) => `"${n.replace(/["\\]/g, '\\$&')}"`).join(',')}}`}::text[]`;
  const own = sql`(select array_agg(o.email) from (${CONFIRMED_ADDRESSES}) o where o.account_id = ${accountId})`;
  const textMatch = query
    ? sql`(p.search @@ websearch_to_tsquery('english', ${query}) or p.authors::text ilike ${`%${query.replace(/[\\%_]/g, '\\$&')}%`})`
    : null;
  const candidates = query
    ? sql`select p.id from papers p where p.merged_into is null and ${textMatch} limit 500`
    : sql`
        select c.page_id as id from page_current c join pdf_documents d on d.sha256 = c.pdf ->> 'sha256'
         where d.emails && coalesce(${own}, '{}')
        union
        select p.id from papers p where cardinality(${namesArray}) > 0 and p.authors ?| ${namesArray}`;
  const { rows } = await database.execute<{
    id: string;
    authors: string[];
    by_email: boolean;
    emails: string[] | null;
    first_page_raw: string | null;
    mine_index: number | null;
    mine_status: string | null;
    taken: number[];
  }>(sql`
    with cand as (${candidates})
    select p.id, p.authors,
           coalesce(d.emails && coalesce(${own}, '{}'), false) as by_email,
           d.emails, d.first_page_raw,
           mine.author_index as mine_index, mine.status as mine_status,
           coalesce((select array_agg(t.author_index) from author_claims t
                      where t.paper_id = p.id and t.status = 'confirmed'), '{}') as taken
      from cand join papers p on p.id = cand.id
      left join page_current c on c.page_id = p.id
      left join pdf_documents d on d.sha256 = c.pdf ->> 'sha256'
      left join author_claims mine on mine.paper_id = p.id and mine.account_id = ${accountId}
     where p.merged_into is null and jsonb_array_length(p.authors) > 0
     order by (mine.status = 'confirmed') nulls first,
              by_email desc,
              (cardinality(${namesArray}) > 0 and p.authors ?| ${namesArray}) desc,
              ${query ? sql`ts_rank(p.search, websearch_to_tsquery('english', ${query})) desc,` : sql``}
              p.year desc nulls last, p.id
     limit ${SUGGESTION_LIMIT}
  `);
  if (rows.length === 0) return [];
  const [summaryOf, ownEmails] = await Promise.all([
    summaries(
      rows.map((r) => r.id),
      database,
    ),
    confirmedAddresses(accountId, database),
  ]);
  const out: ClaimSuggestion[] = [];
  for (const row of rows) {
    const summary = summaryOf.get(row.id);
    if (!summary) continue;
    let likely: number | null = null;
    if (row.by_email && row.emails) {
      const owners = authorsForEmails(row.emails, row.authors, row.first_page_raw ?? '');
      for (const email of ownEmails) if (owners.has(email)) likely = owners.get(email)!;
    }
    if (likely === null) {
      const index = row.authors.findIndex((a) => names.includes(a));
      if (index >= 0) likely = index;
    }
    out.push({
      ...summary,
      authors: row.authors,
      byEmail: row.by_email,
      likely,
      taken: row.taken,
      mine: row.mine_status ? { authorIndex: row.mine_index!, status: row.mine_status } : null,
    });
  }
  return out;
}
