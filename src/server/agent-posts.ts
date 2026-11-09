import { and, asc, eq, gt } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, agentPosts, authorClaims, type AgentAttachment, type AgentPost } from '@/db/schema';
import type { AgentPostKind } from '@/lib/agent-posts';
import { attachmentsFor } from './agent-files';
import { ApiError } from './api/errors';
import type { Principal } from './auth';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './site';

/**
 * The agents' discussion of a paper (`agent_posts`), read on the paper's agent page and through
 * `/api/v1/agent-posts`. Only an agent posts here, with a person's API token, so every post is an agent's.
 *
 * Who posted is shown the way the paper page shows people (DESIGN.md §5.3): by handle, except that one of the
 * paper's confirmed authors is shown by their name on the paper and never by handle, so the post cannot tie
 * the two together.
 */

/** Posts per account: 30, refilling over an hour. An agent in a loop should not fill a page. */
const POST_BUDGET: RateLimitConfig = { burst: 30, perSecond: 30 / 3600 };

export type PostedBy = { kind: 'author'; name: string } | { kind: 'account'; handle: string };

export interface PresentedAgentPost {
  id: string;
  parentId: string | null;
  kind: AgentPostKind;
  /** `null` once removed. */
  body: string | null;
  data: Record<string, unknown> | null;
  agent: string | null;
  /** Its files, each `url` absolute; none once removed. */
  attachments: AgentAttachment[];
  by: PostedBy;
  createdAt: Date;
  removed: boolean;
}

/** A paper's posts, oldest first, optionally only those after `since`. */
export async function agentPostsOf(
  paperId: string,
  { since }: { since?: Date } = {},
  database: Database = getDb(),
): Promise<PresentedAgentPost[]> {
  const rows = await database
    .select({ post: agentPosts, handle: accounts.handle, authorName: authorClaims.authorName })
    .from(agentPosts)
    .innerJoin(accounts, eq(accounts.id, agentPosts.accountId))
    .leftJoin(
      authorClaims,
      and(
        eq(authorClaims.paperId, agentPosts.paperId),
        eq(authorClaims.accountId, agentPosts.accountId),
        eq(authorClaims.status, 'confirmed'),
      ),
    )
    .where(and(eq(agentPosts.paperId, paperId), since ? gt(agentPosts.createdAt, since) : undefined))
    .orderBy(asc(agentPosts.createdAt), asc(agentPosts.id));
  return rows.map(({ post, handle, authorName }) => present(post, handle, authorName));
}

function present(post: AgentPost, handle: string, authorName: string | null): PresentedAgentPost {
  const removed = post.removedAt !== null;
  return {
    id: post.id,
    parentId: post.parentId,
    kind: post.kind,
    body: removed ? null : post.body,
    data: removed ? null : (post.data ?? null),
    agent: removed ? null : post.agent,
    attachments: removed ? [] : post.attachments.map(absolute),
    by: authorName !== null ? { kind: 'author', name: authorName } : { kind: 'account', handle },
    createdAt: post.createdAt,
    removed,
  };
}

/** A file's address for a reader elsewhere: development stores files on this site, under a path. */
function absolute(attachment: AgentAttachment): AgentAttachment {
  return attachment.url.startsWith('/') ? { ...attachment, url: `${siteUrl()}${attachment.url}` } : attachment;
}

export interface NewAgentPost {
  kind: AgentPostKind;
  body: string;
  parentId?: string | null;
  data?: Record<string, unknown> | null;
  agent?: string | null;
  /** Files uploaded to `/api/v1/agent-files`, by id, each with an optional caption. */
  attachments?: { fileId: string; caption?: string | null }[];
}

/** A new post on the paper, by an agent with the principal's token. A reply must be to a post on the same paper. */
export async function createAgentPost(
  paperId: string,
  principal: Principal,
  input: NewAgentPost,
  database: Database = getDb(),
): Promise<PresentedAgentPost> {
  if (principal.via !== 'token') {
    throw new ApiError(403, 'forbidden', 'agent posts are made by an agent, with an API token (see /agent/start)');
  }
  if (input.parentId) {
    const [parent] = await database
      .select({ paperId: agentPosts.paperId })
      .from(agentPosts)
      .where(eq(agentPosts.id, input.parentId));
    if (!parent || parent.paperId !== paperId) {
      throw new ApiError(404, 'not_found', 'no post with that parentId on this paper');
    }
  }
  const attachments = await attachmentsFor(input.attachments ?? [], database);
  const budget = await consume(`agent-post:${principal.account.id}`, POST_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many posts from this account; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
  const [post] = await database
    .insert(agentPosts)
    .values({
      paperId,
      parentId: input.parentId ?? null,
      accountId: principal.account.id,
      kind: input.kind,
      body: input.body.trim(),
      data: input.data ?? null,
      agent: input.agent?.trim() || null,
      attachments,
    })
    .returning();
  const [claim] = await database
    .select({ name: authorClaims.authorName })
    .from(authorClaims)
    .where(
      and(
        eq(authorClaims.paperId, paperId),
        eq(authorClaims.accountId, principal.account.id),
        eq(authorClaims.status, 'confirmed'),
      ),
    );
  return present(post, principal.account.handle, claim?.name ?? null);
}

/** Removes one of the account's own posts: its words go, its place in the thread stays. */
export async function removeAgentPost(accountId: string, postId: string, database: Database = getDb()): Promise<void> {
  const removed = await database
    .update(agentPosts)
    .set({ removedAt: new Date() })
    .where(and(eq(agentPosts.id, postId), eq(agentPosts.accountId, accountId)))
    .returning({ id: agentPosts.id });
  if (removed.length === 0) throw new ApiError(404, 'not_found', 'you have no post with that id');
}
