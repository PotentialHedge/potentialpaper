import { and, count, desc, eq, inArray, ne, notInArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { accounts, commentMentions, comments, pageEvents, paperFollows } from '@/db/schema';
import { aliasName } from '@/lib/aliases';
import { renderCoAuthorMail, renderCommentMail, renderEditMail } from '@/lib/follow-mail';
import { shownHandle } from '@/lib/profile';
import { toolPath } from '@/lib/page-tools';
import { getComment } from './comments';
import { sendMail } from './mail';
import { summaries, type PaperSummary } from './my-papers';
import { consume, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './site';

/**
 * Following (starring) papers: a follower is mailed when the paper's page is edited or someone comments on it.
 * Anyone signed in follows and unfollows from the star under a paper's title, and sees what they follow on My
 * papers. A confirmed author follows their paper from the moment their claim is confirmed (`followPaper` from
 * `server/claims.ts`), and can unfollow it like anyone else.
 *
 * **Who follows is private.** Only the count is public.
 *
 * Mail goes to the login address, if it is confirmed, never to the person who made the change, a bot, or an account
 * that turned `follow_mail` off. Each follower has a budget per paper and kind of mail, so a busy page can't fill an
 * inbox: edits at most {@link EDIT_MAIL_BUDGET} (one an hour, a mail standing for the edits since), comments
 * {@link COMMENT_MAIL_BUDGET}. Over it, nothing is sent. Someone the comment `@`-mentions isn't mailed about it here
 * as well (`server/mentions.ts` does that).
 *
 * The mail senders are called after the change is committed and never awaited by the request: a mail failure must
 * never fail the edit or the post.
 */

export const EDIT_MAIL_BUDGET: RateLimitConfig = { burst: 1, perSecond: 1 / 3600 };
export const COMMENT_MAIL_BUDGET: RateLimitConfig = { burst: 5, perSecond: 5 / 86_400 };

/** Follows the paper; following it again changes nothing. */
export async function followPaper(paperId: string, accountId: string, database: Database = getDb()): Promise<void> {
  await database.insert(paperFollows).values({ paperId, accountId }).onConflictDoNothing();
}

export async function unfollowPaper(paperId: string, accountId: string, database: Database = getDb()): Promise<void> {
  await database
    .delete(paperFollows)
    .where(and(eq(paperFollows.paperId, paperId), eq(paperFollows.accountId, accountId)));
}

/** How many follow the paper, and whether the viewer does (`null` for nobody signed in). */
export async function followState(
  paperId: string,
  viewerId: string | null,
  database: Database = getDb(),
): Promise<{ following: boolean | null; followers: number }> {
  const [[total], mine] = await Promise.all([
    database.select({ n: count() }).from(paperFollows).where(eq(paperFollows.paperId, paperId)),
    viewerId
      ? database
          .select({ paperId: paperFollows.paperId })
          .from(paperFollows)
          .where(and(eq(paperFollows.paperId, paperId), eq(paperFollows.accountId, viewerId)))
      : Promise.resolve(null),
  ]);
  return { following: mine === null ? null : mine.length > 0, followers: total?.n ?? 0 };
}

export interface FollowedPaper extends PaperSummary {
  followedAt: Date;
}

/** The papers the account follows, most recently followed first. Private to the account. */
export async function followedPapers(accountId: string, database: Database = getDb()): Promise<FollowedPaper[]> {
  const rows = await database
    .select({ paperId: paperFollows.paperId, createdAt: paperFollows.createdAt })
    .from(paperFollows)
    .where(eq(paperFollows.accountId, accountId))
    .orderBy(desc(paperFollows.createdAt));
  const summaryOf = await summaries(
    rows.map((r) => r.paperId),
    database,
  );
  return rows.flatMap((r) => {
    const summary = summaryOf.get(r.paperId);
    return summary ? [{ ...summary, followedAt: r.createdAt }] : [];
  });
}

/** Followers who may be mailed about the paper: not `except`, nor bots, nor those who turned it off. */
async function recipients(paperId: string, except: readonly string[], database: Database) {
  return database
    .select({ accountId: accounts.id, email: user.email })
    .from(paperFollows)
    .innerJoin(accounts, eq(accounts.id, paperFollows.accountId))
    .innerJoin(user, eq(user.id, accounts.userId))
    .where(
      and(
        eq(paperFollows.paperId, paperId),
        eq(accounts.followMail, true),
        eq(accounts.isBot, false),
        eq(user.emailVerified, true),
        ...(except.length > 0 ? [notInArray(accounts.id, [...except])] : []),
      ),
    );
}

function notes(base: string) {
  return { papersUrl: `${base}/papers#following`, settingsUrl: `${base}/profile#email` };
}

/**
 * Mails the paper's followers that its page changed, by the commits numbered `seqs` (one web edit, or a push's),
 * which `actorId` made. Returns how many it mailed.
 */
export async function mailEditFollowers(
  paperId: string,
  actorId: string,
  seqs: readonly number[],
  database: Database = getDb(),
): Promise<number> {
  if (seqs.length === 0) return 0;
  const to = await recipients(paperId, [actorId], database);
  if (to.length === 0) return 0;
  const [paper] = (await summaries([paperId], database)).values();
  if (!paper) return 0;
  const [last] = await database
    .select({ payload: pageEvents.payload })
    .from(pageEvents)
    .where(and(eq(pageEvents.pageId, paperId), inArray(pageEvents.seq, [...seqs])))
    .orderBy(desc(pageEvents.seq))
    .limit(1);
  const summary = typeof last?.payload.summary === 'string' ? last.payload.summary : '';

  const base = siteUrl();
  const mail = renderEditMail({
    title: paper.title,
    summary,
    commits: seqs.length,
    url: `${base}${paper.path}`,
    historyUrl: `${base}${toolPath('history', { kind: 'paper', id: paper.canonical })}`,
    ...notes(base),
  });
  let sent = 0;
  for (const r of to) {
    if (!(await consume(`follow-edit-mail:${r.accountId}:${paperId}`, EDIT_MAIL_BUDGET)).allowed) continue;
    await sendMail({ to: r.email, ...mail });
    sent += 1;
  }
  return sent;
}

/** Mails the paper's followers a new comment, but not its author or anyone it mentions. Returns how many. */
export async function mailCommentFollowers(commentId: string, database: Database = getDb()): Promise<number> {
  const [c] = await database
    .select({ body: comments.body, accountId: comments.accountId, paperId: comments.paperId })
    .from(comments)
    .where(eq(comments.id, commentId));
  if (!c) return 0;
  const mentioned = await database
    .select({ accountId: commentMentions.accountId })
    .from(commentMentions)
    .where(eq(commentMentions.commentId, commentId));
  const to = await recipients(c.paperId, [c.accountId, ...mentioned.map((m) => m.accountId)], database);
  if (to.length === 0) return 0;
  const shown = await getComment(commentId, database);
  if (!shown) return 0;

  const base = siteUrl();
  const author = shown.comment.author;
  const from =
    author.kind === 'alias'
      ? aliasName(author.alias)
      : author.kind === 'author'
        ? author.name
        : `@${shownHandle(author.handle, author.bot)}`;
  const mail = renderCommentMail({
    from,
    title: shown.paper.title,
    body: c.body,
    url: `${base}${shown.paper.path}`,
    ...notes(base),
  });
  let sent = 0;
  for (const r of to) {
    if (!(await consume(`follow-comment-mail:${r.accountId}:${c.paperId}`, COMMENT_MAIL_BUDGET)).allowed) continue;
    await sendMail({ to: r.email, ...mail });
    sent += 1;
  }
  return sent;
}

/**
 * Tells an author that a co-author added them (`addCoAuthor`). Sent whatever `follow_mail` says, as it is about
 * their own name on a paper, unless the address is unconfirmed. Returns whether it was sent.
 */
export async function mailAddedCoAuthor(
  paperId: string,
  added: { accountId: string; authorName: string },
  voucherHandle: string,
  database: Database = getDb(),
): Promise<boolean> {
  const [r] = await database
    .select({ email: user.email })
    .from(accounts)
    .innerJoin(user, eq(user.id, accounts.userId))
    .where(and(eq(accounts.id, added.accountId), eq(user.emailVerified, true), ne(accounts.isBot, true)));
  if (!r) return false;
  const [paper] = (await summaries([paperId], database)).values();
  if (!paper) return false;
  const base = siteUrl();
  await sendMail({
    to: r.email,
    ...renderCoAuthorMail({
      by: `@${voucherHandle}`,
      title: paper.title,
      authorName: added.authorName,
      url: `${base}${paper.path}`,
      papersUrl: `${base}/papers`,
    }),
  });
  return true;
}
