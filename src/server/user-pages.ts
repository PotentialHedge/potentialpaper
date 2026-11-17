import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  accounts,
  authorClaims,
  comments,
  commitIdentities,
  pageCurrent,
  pageEvents,
  pageRevisions,
  type Account,
} from '@/db/schema';
import { LINKS_FILE } from '@/lib/labeled-links';
import { parseSettings, resolveSettings } from '@/lib/settings';
import { profileFileText, shownFromSettings, type UserShown, USER_SHOW_ITEMS } from '@/lib/user-pages';
import type { PageSummary } from '@/lib/plugins/protocol';
import { commitPage, SYSTEM_ACTOR } from './pages/commit';
import { findKeyedPage, type PageRow } from './pages/kinds';
import { refreshPages } from './pages/refresh';
import { readHead, type Reader } from './pages/repo';
import { LAYOUT_VERSION, METADATA_PATH } from './pages/rules';
import { pageSummaries } from './plugins/pages';
import { summaries } from './my-papers';
import { userSettingsRow } from './settings';

/**
 * A person's page, `/u/<handle>` (`handoffs/pages.md` Phase 3): what it shows the public, and keeping it with its
 * account. Every account has one, made and moved with the account by triggers (migration `0037`): keyed by the
 * handle, so a new handle moves the key and leaves a redirect (`page_redirects`).
 *
 * **The §5.3 rule lives here** (DESIGN.md §5.3): the page shows its handle, its `about/` and its links, and of the
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
 * What the account chose to show, from its own settings.json alone: `user.show.*` are `accountOnly`, so the site
 * layer can't turn them on for everyone.
 */
export async function shownFor(accountId: string): Promise<UserShown> {
  const { text } = await userSettingsRow(accountId);
  return shownFromSettings(resolveSettings({ user: parseSettings(text) }));
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
  const shown = await shownFor(account.id);
  const [claimedPapers, activity, commentList] = await Promise.all([
    shown.claimedPapers ? claimedPapersOf(account.id, database) : null,
    shown.activity && !account.isBot ? activityOf(account.id, limit, database) : shown.activity ? [] : null,
    shown.comments ? commentsOf(account.id, limit, database) : null,
  ]);
  return {
    handle: account.handle,
    bot: account.isBot,
    shown,
    realName: shown.realName ? account.realName : null,
    institutions: shown.institution ? account.institutions : null,
    claimedPapers,
    activity,
    comments: commentList,
  };
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
 * Starts the account's page repo, if it hasn't one: the system's first commit, with its `profile.json` as the
 * account's settings say, so it can be cloned and pushed to from the start. The page's row is the trigger's. Never
 * fails what called it (a sign-up).
 */
export async function startUserPage(
  account: Pick<Account, 'id' | 'handle'>,
  database: Database = getDb(),
): Promise<void> {
  try {
    await syncProfileFile(account, database);
  } catch (err) {
    console.error(`starting the page of @${account.handle} failed`, err);
  }
}

/**
 * Brings the page's `profile.json` in line with the account's `user.show.*` settings: a commit by the system, only
 * when it differs; on a page with no repo yet, its first commit. Called when the account is made, when its settings
 * are saved, and by `npm run users:pages`. The page reads the settings, never the file, so a failure here shows nothing it shouldn't.
 */
export async function syncProfileFile(
  account: Pick<Account, 'id' | 'handle'>,
  database: Database = getDb(),
): Promise<'committed' | 'unchanged' | 'no-page'> {
  const page = await findKeyedPage(database, 'user', account.handle);
  if (!page) return 'no-page';
  const shown = await shownFor(account.id);
  const text = profileFileText(shown);
  const [current] = await database
    .select({ kindFile: pageCurrent.kindFile })
    .from(pageCurrent)
    .where(eq(pageCurrent.pageId, page.id));
  const head = await readHead(database, page.id);
  const result = await commitPage(
    page.id,
    head,
    SYSTEM_ACTOR,
    [{ path: 'profile.json', content: text }],
    showSummary(shown, current?.kindFile ?? null),
    {
      database,
    },
  );
  if (result.status !== 'committed') return 'unchanged';
  await refreshPages({ kind: 'user', key: account.handle });
  return 'committed';
}

/** The commit's summary: what changed, in words. */
function showSummary(shown: UserShown, before: Record<string, unknown> | null): string {
  const was = (before?.show ?? {}) as Partial<UserShown>;
  const on = USER_SHOW_ITEMS.filter((item) => shown[item] && was[item] !== true);
  const off = USER_SHOW_ITEMS.filter((item) => !shown[item] && was[item] === true);
  const words = [...(on.length ? [`Show ${on.join(', ')}`] : []), ...(off.length ? [`Hide ${off.join(', ')}`] : [])];
  return words.length ? words.join('; ') : 'What this page shows';
}

/**
 * After a handle changed (the trigger moved the page and left a redirect): the page's metadata says its new key, and
 * both addresses are rendered again. Never fails the change, which has happened.
 */
export async function afterHandleChange(oldHandle: string, newHandle: string, database: Database = getDb()) {
  try {
    const page = await findKeyedPage(database, 'user', newHandle);
    if (page && (await readHead(database, page.id))) {
      const content = `${JSON.stringify({ layout: LAYOUT_VERSION, kind: 'user', key: newHandle }, null, 2)}\n`;
      await commitPage(
        page.id,
        await readHead(database, page.id),
        SYSTEM_ACTOR,
        [{ path: METADATA_PATH, content }],
        `Handle is now @${newHandle}`,
        { database },
      );
    }
    await refreshPages({ kind: 'user', key: oldHandle });
    await refreshPages({ kind: 'user', key: newHandle });
  } catch (err) {
    console.error(`moving the page of @${oldHandle} to @${newHandle} failed`, err);
  }
}
