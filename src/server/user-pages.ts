import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  accounts,
  authorClaims,
  comments,
  commitIdentities,
  pageEvents,
  pageRevisions,
  type Account,
} from '@/db/schema';
import { keyedPagePath } from '@/lib/kinds';
import type { ProfileLinks } from '@/lib/profile';
import { LINKS_FILE } from '@/lib/labeled-links';
import { parseSettings, resolveSettings } from '@/lib/settings';
import { shownFromSettings, type UserShown } from '@/lib/user-pages';
import type { PageSummary } from '@/lib/plugins/protocol';
import type { PageRow } from './pages/kinds';
import { refreshPageIds, refreshPages } from './pages/refresh';
import type { Reader } from './pages/repo';
import { pageSummaries } from './plugins/pages';
import { summaries } from './my-papers';
import { userSettingsRow } from './settings';

/**
 * A person's page, `/u/<handle>` (`handoffs/pages.md` Phase 3): what it shows the public, and keeping it with its
 * account. Every account has one, made and moved with the account by triggers (migration `0037`): keyed by the
 * handle, so a new handle moves the key and leaves a redirect (`page_redirects`).
 *
 * **The §5.3 rule lives here** (DESIGN.md §5.3): the page shows its handle, its `owners/` and its links, and of the
 * rest only what the account turned on in its `user.show.*` settings (`lib/user-pages.ts`), which default to nothing
 * that ties the handle to a real name or an author identity. The page (`components/pages/user-panels.tsx`), the
 * plugins' `page.read` and the public routes all read `userPageView`, so a plugin sees exactly what the public does.
 *
 * Never listed, whatever the settings say: edits made under a per-claim author identity (`a_…`), comments on a paper
 * the account is a confirmed author of (they carry the author's name there), anonymous comments, and a bot's page's
 * activity (bot commits are hidden, as in the feed).
 */

/** The account a user page is: the one whose handle is the page's key. */
export async function accountOfUserPage(db: Reader, key: string): Promise<Account | null> {
  const [row] = await db.select().from(accounts).where(eq(accounts.handle, key));
  return row ?? null;
}

/**
 * What the account chose to show, from its own settings.json alone (`user.show.*` are `accountOnly`, so the site
 * layer can't turn them on for everyone), and its institution as its `show_institution` says.
 */
export async function shownFor(account: Pick<Account, 'id' | 'showInstitution'>): Promise<UserShown> {
  const { text } = await userSettingsRow(account.id);
  return shownFromSettings(resolveSettings({ user: parseSettings(text) }), account.showInstitution);
}

/**
 * A paper's confirmed authors, in the paper's order, each with the address of their page when their account shows the
 * papers it authored (`user.show.claimedPapers`, on unless they turned it off), else `null`: only then does the
 * paper link their printed name to their handle.
 */
export async function linkedAuthors(
  paperId: string,
  database: Database = getDb(),
): Promise<{ authorIndex: number; authorName: string; href: string | null }[]> {
  const rows = await database
    .select({
      authorIndex: authorClaims.authorIndex,
      authorName: authorClaims.authorName,
      accountId: accounts.id,
      handle: accounts.handle,
      showInstitution: accounts.showInstitution,
    })
    .from(authorClaims)
    .innerJoin(accounts, eq(accounts.id, authorClaims.accountId))
    .where(and(eq(authorClaims.paperId, paperId), eq(authorClaims.status, 'confirmed')))
    .orderBy(authorClaims.authorIndex);
  return Promise.all(
    rows.map(async (r) => ({
      authorIndex: r.authorIndex,
      authorName: r.authorName,
      href: (await shownFor({ id: r.accountId, showInstitution: r.showInstitution })).claimedPapers
        ? keyedPagePath('user', r.handle)
        : null,
    })),
  );
}

/** Renders again the papers the account is a confirmed author of, whose author names link to its page or not. */
async function refreshAuthoredPapers(accountId: string, database: Database): Promise<void> {
  const rows = await database
    .select({ paperId: authorClaims.paperId })
    .from(authorClaims)
    .where(and(eq(authorClaims.accountId, accountId), eq(authorClaims.status, 'confirmed')));
  await refreshPageIds(
    database,
    rows.map((r) => r.paperId),
  );
}

export interface ClaimedPaper {
  page: PageSummary;
  year: number | null;
  /** The name the account is on the paper, as printed. */
  authorName: string;
}

export interface ActivityItem {
  page: PageSummary;
  summary: string;
  kind: 'edit' | 'revert';
  /** Whether the commit changed a `links.jsonl`: a labeled link added, changed or removed. */
  links: boolean;
  at: Date;
}

export interface CommentItem {
  id: string;
  page: PageSummary;
  /** The comment's opening words, as plain text. */
  excerpt: string;
  at: Date;
}

export interface UserPageView {
  handle: string;
  bot: boolean;
  shown: UserShown;
  /** What the person wrote about themselves (Markdown with TeX), or `null`: public whenever they write one. */
  bio: string | null;
  /** Their homepage, ORCID iD and Scholar profile, each `null` when unset: public, like the bio. */
  links: ProfileLinks;
  /** Each item only when shown, else `null`. */
  realName: string | null;
  institutions: string[] | null;
  claimedPapers: ClaimedPaper[] | null;
  activity: ActivityItem[] | null;
  comments: CommentItem[] | null;
}

const LIST_LIMIT = 50;

/** The page's view for the public, or `null` if no account has the page's handle (a page an admin made). */
export async function userPageView(
  page: PageRow,
  { limit = LIST_LIMIT }: { limit?: number } = {},
  database: Database = getDb(),
): Promise<UserPageView | null> {
  if (page.kind !== 'user') return null;
  const account = await accountOfUserPage(database, page.key);
  if (!account) return null;
  const shown = await shownFor(account);
  const [claimedPapers, activity, commentList] = await Promise.all([
    shown.claimedPapers ? claimedPapersOf(account.id, database) : null,
    shown.activity && !account.isBot ? activityOf(account.id, limit, database) : shown.activity ? [] : null,
    shown.comments ? commentsOf(account.id, limit, database) : null,
  ]);
  return {
    handle: account.handle,
    bot: account.isBot,
    shown,
    bio: account.bio,
    links: { homepage: account.homepage, orcid: account.orcid, scholar: account.scholar },
    realName: shown.realName ? account.realName : null,
    institutions: shown.institution ? account.institutions : null,
    claimedPapers,
    activity,
    comments: commentList,
  };
}

/**
 * The people an org page lists (`handoffs/pages.md` Phase 4): accounts with a confirmed address at one of its domains
 * or its departments' (or under one), that are verified, not bots, and **show their institution**
 * (`show_institution`, the same choice that shows it on their page and beside their handle). Only their handles: a
 * real name stays as `user.show.realName` says, on their own page. Never anyone who chose not to show it.
 */
export async function orgPeople(
  scopeId: string,
  { limit = 100 }: { limit?: number } = {},
  database: Database = getDb(),
): Promise<{ handles: string[]; count: number }> {
  const { rows } = await database.execute<{ handle: string; total: number }>(sql`
    with domains as (
      select substr(n.name, length('domain:') + 1) as domain
        from page_scope_names n
       where n.name like 'domain:%'
         and (n.page_id = ${scopeId}
              or n.page_id in (select page_id from page_ancestors where ancestor_id = ${scopeId}))
    ), people as (
      select distinct a.handle
        from affiliations f
        join accounts a on a.id = f.account_id
        cross join lateral domain_suffixes(split_part(f.email, '@', 2)) s(domain)
       where f.verified_at is not null
         and a.show_institution and a.verified_at is not null and not a.is_bot
         and s.domain in (select domain from domains)
    )
    select handle, (count(*) over ())::int as total from people order by handle limit ${limit}
  `);
  return { handles: rows.map((row) => row.handle), count: rows[0]?.total ?? 0 };
}

/** The papers the account is a confirmed author of, newest first. */
async function claimedPapersOf(accountId: string, database: Database): Promise<ClaimedPaper[]> {
  const claims = await database
    .select({ paperId: authorClaims.paperId, authorName: authorClaims.authorName })
    .from(authorClaims)
    .where(and(eq(authorClaims.accountId, accountId), eq(authorClaims.status, 'confirmed')));
  const [found, papers] = await Promise.all([
    pageSummaries(
      claims.map((c) => c.paperId),
      database,
    ),
    summaries(
      claims.map((c) => c.paperId),
      database,
    ),
  ]);
  return claims
    .flatMap((claim) => {
      const page = found.get(claim.paperId);
      const paper = papers.get(claim.paperId);
      return page && paper ? [{ page, year: paper.year, authorName: claim.authorName }] : [];
    })
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.page.name.localeCompare(b.page.name));
}

/**
 * The account's commits under its handle (its `u_` identity), on pages of every kind, newest first. A commit under a
 * per-claim author identity (`a_…`, on the account's own paper) has another `author_id`, so it is never here.
 */
async function activityOf(accountId: string, limit: number, database: Database): Promise<ActivityItem[]> {
  const rows = await database
    .select({
      pageId: pageRevisions.pageId,
      summary: pageRevisions.summary,
      kind: pageRevisions.kind,
      paths: pageRevisions.paths,
      at: pageRevisions.at,
    })
    .from(pageRevisions)
    .innerJoin(commitIdentities, eq(commitIdentities.id, pageRevisions.authorId))
    // In the outbox's order: commits a second apart on different pages can't be told apart by time.
    .innerJoin(pageEvents, and(eq(pageEvents.pageId, pageRevisions.pageId), eq(pageEvents.seq, pageRevisions.seq)))
    .where(and(eq(pageRevisions.accountId, accountId), eq(commitIdentities.accountId, accountId)))
    .orderBy(desc(pageEvents.id))
    .limit(limit);
  const found = await pageSummaries(
    rows.map((row) => row.pageId),
    database,
  );
  return rows.flatMap((row) => {
    const page = found.get(row.pageId);
    if (!page) return [];
    const links = row.paths.some((path) => path === LINKS_FILE || path.endsWith(`/${LINKS_FILE}`));
    return [{ page, summary: row.summary, kind: row.kind, links, at: row.at }];
  });
}

const EXCERPT = 240;

/** Plain words from a comment's Markdown, for a list. */
export function commentExcerpt(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1).trimEnd()}…` : text;
}

/**
 * The account's comments under its handle, newest first: not anonymous, not removed, and not on a paper it is a
 * confirmed author of, where its comments carry its name on the paper instead.
 */
async function commentsOf(accountId: string, limit: number, database: Database): Promise<CommentItem[]> {
  const rows = await database
    .select({ id: comments.id, paperId: comments.paperId, body: comments.body, at: comments.createdAt })
    .from(comments)
    .where(
      and(
        eq(comments.accountId, accountId),
        eq(comments.anonymous, false),
        isNull(comments.removedAt),
        sql`not exists (
          select 1 from ${authorClaims}
          where ${authorClaims.paperId} = ${comments.paperId}
            and ${authorClaims.accountId} = ${comments.accountId}
            and ${authorClaims.status} = 'confirmed'
        )`,
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(limit);
  const found = await pageSummaries(
    rows.map((row) => row.paperId),
    database,
  );
  return rows.flatMap((row) => {
    const page = found.get(row.paperId);
    return page ? [{ id: row.id, page, excerpt: commentExcerpt(row.body), at: row.at }] : [];
  });
}

/**
 * After what the page shows changed (its `user.show.*` settings, its institution choice, its bio or links): the page is
 * rendered again, and so are its papers, whose author names link here only while it shows them. Never fails the
 * change, which has happened.
 */
export async function afterProfileChange(account: Pick<Account, 'id' | 'handle'>, database: Database = getDb()) {
  try {
    await refreshPages({ kind: 'user', key: account.handle });
    await refreshAuthoredPapers(account.id, database);
  } catch (err) {
    console.error(`rendering the page of @${account.handle} again failed`, err);
  }
}

/** After a handle changed (the trigger moved the page and left a redirect): both addresses are rendered again. */
export async function afterHandleChange(oldHandle: string, newHandle: string, database: Database = getDb()) {
  try {
    await refreshPages({ kind: 'user', key: oldHandle });
    await refreshPages({ kind: 'user', key: newHandle });
    const [account] = await database.select({ id: accounts.id }).from(accounts).where(eq(accounts.handle, newHandle));
    // Its papers link the author's name to the new address.
    if (account) await refreshAuthoredPapers(account.id, database);
  } catch (err) {
    console.error(`moving the page of @${oldHandle} to @${newHandle} failed`, err);
  }
}
