import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  accounts,
  authorClaims,
  pages,
  paperIdentifiers,
  papers,
  type ClaimMethod,
  type ClaimStatus,
} from '@/db/schema';
import { canonicalPaperId, shortPath, type PaperId } from '@/lib/paper-ids';
import { canStepDown, CONFIRMED_ADDRESSES } from './claims';

/**
 * The papers on an account's "My papers" page (`app/papers`). Each list is of {@link PaperSummary} plus what ties
 * the account to the paper, so another tie (following a paper, say) is another list of the same rows.
 */

/** What any row on My papers shows of the paper itself. */
export interface PaperSummary {
  paperId: string;
  title: string;
  year: number | null;
  venue: string | null;
  /** The identifier the paper is best known by, and its page. */
  canonical: PaperId;
  path: string;
}

/** Someone waiting to be confirmed as an author of a paper the account is a confirmed author of. */
export interface WaitingClaim {
  claimId: string;
  authorIndex: number;
  authorName: string;
  evidence: string;
  /** Who they are, as they let the public see it: never their handle, which nothing ties to the paper. */
  realName: string | null;
  institutions: string[];
  /** Their confirmed addresses: asking co-authors shows them, so they can tell who it is. */
  addresses: string[];
  createdAt: Date;
}

export interface AuthoredPaper extends PaperSummary {
  /** Names as printed on the paper, in order. */
  authors: string[];
  /** The account's own claim: who it is on the paper, and whether that is confirmed yet. */
  mine: { authorIndex: number; authorName: string; status: ClaimStatus; method: ClaimMethod; canStepDown: boolean };
  /** The paper's confirmed authors, the account among them when it is one, in the paper's order. */
  confirmed: { authorIndex: number; authorName: string }[];
  /** Claims by others waiting on an admin, which a confirmed author can confirm. Empty unless the account is one. */
  waiting: WaitingClaim[];
}

/** Each paper's summary, keyed by id, for papers not merged into another. */
export async function summaries(paperIds: readonly string[], database: Database): Promise<Map<string, PaperSummary>> {
  if (paperIds.length === 0) return new Map();
  const [rows, ids] = await Promise.all([
    database
      .select({ id: papers.id, title: papers.title, year: papers.year, venue: papers.venue, shortId: pages.shortId })
      .from(papers)
      .innerJoin(pages, eq(pages.id, papers.id))
      .where(and(inArray(papers.id, [...paperIds]), isNull(papers.mergedInto))),
    database
      .select({ paperId: paperIdentifiers.paperId, scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
      .from(paperIdentifiers)
      .where(inArray(paperIdentifiers.paperId, [...paperIds])),
  ]);
  const byPaper = new Map<string, PaperId[]>();
  for (const id of ids) byPaper.set(id.paperId, [...(byPaper.get(id.paperId) ?? []), id]);
  const out = new Map<string, PaperSummary>();
  for (const row of rows) {
    const canonical = canonicalPaperId(byPaper.get(row.id) ?? []);
    if (!canonical) continue;
    out.set(row.id, {
      paperId: row.id,
      title: row.title,
      year: row.year,
      venue: row.venue,
      canonical: { scheme: canonical.scheme, value: canonical.value },
      path: shortPath(row.shortId),
    });
  }
  return out;
}

/**
 * The papers the account is an author of, or has asked to be: confirmed and pending claims, newest paper first.
 * **Private** to the account: it carries what others wrote to claim a co-authored paper.
 */
export async function authoredPapers(accountId: string, database: Database = getDb()): Promise<AuthoredPaper[]> {
  const own = await database
    .select({
      paperId: authorClaims.paperId,
      authorIndex: authorClaims.authorIndex,
      authorName: authorClaims.authorName,
      status: authorClaims.status,
      method: authorClaims.method,
      authors: papers.authors,
    })
    .from(authorClaims)
    .innerJoin(papers, eq(papers.id, authorClaims.paperId))
    .where(and(eq(authorClaims.accountId, accountId), inArray(authorClaims.status, ['confirmed', 'pending'])));
  if (own.length === 0) return [];
  const paperIds = own.map((row) => row.paperId);
  const confirmedOn = own.filter((row) => row.status === 'confirmed').map((row) => row.paperId);

  const [summaryOf, confirmed, waiting] = await Promise.all([
    summaries(paperIds, database),
    database
      .select({
        paperId: authorClaims.paperId,
        authorIndex: authorClaims.authorIndex,
        authorName: authorClaims.authorName,
      })
      .from(authorClaims)
      .where(and(inArray(authorClaims.paperId, paperIds), eq(authorClaims.status, 'confirmed')))
      .orderBy(asc(authorClaims.authorIndex)),
    confirmedOn.length === 0
      ? Promise.resolve([])
      : database
          .select({
            paperId: authorClaims.paperId,
            claimId: authorClaims.id,
            accountId: authorClaims.accountId,
            authorIndex: authorClaims.authorIndex,
            authorName: authorClaims.authorName,
            evidence: authorClaims.evidence,
            realName: accounts.realName,
            showInstitution: accounts.showInstitution,
            institutions: accounts.institutions,
            createdAt: authorClaims.createdAt,
          })
          .from(authorClaims)
          .innerJoin(accounts, eq(accounts.id, authorClaims.accountId))
          .where(
            and(
              inArray(authorClaims.paperId, confirmedOn),
              eq(authorClaims.status, 'pending'),
              ne(authorClaims.accountId, accountId),
            ),
          )
          .orderBy(asc(authorClaims.createdAt)),
  ]);

  const claimants = [...new Set(waiting.map((w) => w.accountId))];
  const addressesOf = new Map<string, string[]>();
  if (claimants.length > 0) {
    const { rows: found } = await database.execute<{ account_id: string; emails: string[] }>(sql`
      select o.account_id, array_agg(distinct o.email order by o.email) as emails
        from (${CONFIRMED_ADDRESSES}) o
       where o.account_id in (${sql.join(
         claimants.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       group by o.account_id
    `);
    for (const row of found) addressesOf.set(row.account_id, row.emails);
  }

  const rows: AuthoredPaper[] = [];
  for (const claim of own) {
    const summary = summaryOf.get(claim.paperId);
    if (!summary) continue;
    rows.push({
      ...summary,
      authors: claim.authors,
      mine: {
        authorIndex: claim.authorIndex,
        authorName: claim.authorName,
        status: claim.status,
        method: claim.method,
        canStepDown: canStepDown(claim),
      },
      confirmed: confirmed
        .filter((c) => c.paperId === claim.paperId)
        .map(({ authorIndex, authorName }) => ({ authorIndex, authorName })),
      waiting: waiting
        .filter((w) => w.paperId === claim.paperId)
        .map((w) => ({
          claimId: w.claimId,
          authorIndex: w.authorIndex,
          authorName: w.authorName,
          evidence: w.evidence,
          realName: w.realName,
          institutions: w.showInstitution ? w.institutions : [],
          addresses: addressesOf.get(w.accountId) ?? [],
          createdAt: w.createdAt,
        })),
    });
  }
  return rows.sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }),
  );
}
