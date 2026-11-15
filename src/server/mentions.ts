import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { accounts, commentMentions, comments } from '@/db/schema';
import { aliasName } from '@/lib/aliases';
import { renderMentionMail } from '@/lib/mention-mail';
import { getComment } from './comments';
import { sendMail } from './mail';
import { consume, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './site';

/**
 * Mail the accounts a comment `@`-mentions: one mail per account in its `comment_mentions` rows
 * (`server/comments`), to the login address.
 *
 * Not to the author mentioning themself (never a row), a bot, an account that turned `mention_mail` off, or one
 * whose address is unconfirmed. Each recipient has a budget, `mention-mail:<account>`, {@link MENTION_MAIL_BUDGET}:
 * over it the mention still shows on the page and in the inbox, and nothing is sent. Without it anyone could
 * fill an inbox by posting `@ada` over and over.
 *
 * The mail names the mentioner as the page does, so it tells the recipient nothing the discussion doesn't.
 *
 * Called after the comment is committed and never awaited by the request: a mail failure must never fail the
 * post.
 */
export const MENTION_MAIL_BUDGET: RateLimitConfig = { burst: 10, perSecond: 10 / 86_400 };

export async function mailMentions(commentId: string, database: Database = getDb()): Promise<number> {
  const [c] = await database
    .select({ body: comments.body, accountId: comments.accountId })
    .from(comments)
    .where(eq(comments.id, commentId));
  if (!c) return 0;
  const shown = await getComment(commentId, database);
  if (!shown) return 0;

  const recipients = await database
    .select({ accountId: accounts.id, email: user.email })
    .from(commentMentions)
    .innerJoin(accounts, eq(accounts.id, commentMentions.accountId))
    .innerJoin(user, eq(user.id, accounts.userId))
    .where(
      and(
        eq(commentMentions.commentId, commentId),
        eq(accounts.mentionMail, true),
        eq(accounts.isBot, false),
        eq(user.emailVerified, true),
      ),
    );

  const base = siteUrl();
  const author = shown.comment.author;
  const from =
    author.kind === 'alias' ? aliasName(author.alias) : author.kind === 'author' ? author.name : `@${author.handle}`;
  let sent = 0;
  for (const r of recipients) {
    if (!(await consume(`mention-mail:${r.accountId}`, MENTION_MAIL_BUDGET)).allowed) continue;
    const mail = renderMentionMail({
      from,
      title: shown.paper.title,
      body: c.body,
      url: `${base}${shown.paper.path}`,
      settingsUrl: `${base}/profile#email`,
    });
    await sendMail({ to: r.email, ...mail });
    sent += 1;
  }
  return sent;
}
