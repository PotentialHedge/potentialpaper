import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import {
  accounts,
  authorClaims,
  commentAliases,
  commentMentions,
  comments,
  paperIdentifiers,
  papers,
  type Account,
} from '@/db/schema';
import { mentionedNames, randomAlias } from '@/lib/aliases';
import { MAX_COMMENT_LENGTH } from '@/lib/comments';
import { canonicalPaperId, paperPath } from '@/lib/paper-ids';
import { ApiError } from '../api/errors';
import { consume, rateLimitHeaders, type RateLimitConfig } from '../ratelimit';
import { renderComment } from './render';

/**
 * The discussion under a paper (DESIGN.md §9): threaded comments with `@` mentions, in Postgres.
 *
 * **Who wrote a comment is shown as §5.3 says**, and decided when it is read, so it follows the account:
 *
 *   - one of the paper's **confirmed authors** is shown by their name on the paper, with an author badge, and
 *     never by handle, so nothing on the page ties the two. They can't post anonymously there;
 *   - an **anonymous** comment is shown by the account's alias on this paper, OpenReview's "Anonymous k3xm":
 *     random, made the first time the account comments anonymously on the paper (`comment_aliases`), the same
 *     on all its anonymous comments there, and unrelated to its alias on any other paper. That lets a reader
 *     follow one voice and mention it as `@k3xm`. An anonymous comment from before a claim stays anonymous;
 *   - anything else by handle, with the real name and institutions the account chose to show.
 *
 * **Mentions.** `@name` mentions an alias on this paper or an account's handle; an alias wins over a handle
 * spelled the same, since it is what the page shows here. Each comment carries the names in its body that
 * resolve, which its HTML sets apart. They are kept (`comment_mentions`), resolved once when the comment is
 * posted, for the mentioned account's inbox (`listMentions`) and its mail (`server/mentions.ts`).
 *
 * **Replies nest.** A reply names the comment it answers, at any depth. A discussion is never read whole: the
 * top level pages on its own, newest first, with a preview of each tree — the first {@link REPLY_PREVIEW}
 * replies to each comment, {@link LIST_DEPTH} levels down — and `listReplies` pages the rest of any
 * comment's replies, oldest first, each with its own preview. Previews are flat lists; `parentId` makes the
 * tree. A removed comment keeps its place, so its replies still read as answers, and loses its words.
 *
 * Bodies are stored as written (Markdown) and rendered on read (`render.ts`).
 */

/** How many replies to each comment, oldest first, a preview carries. */
export const REPLY_PREVIEW = 3;
/** How many levels of replies come with a page of top-level comments. */
export const LIST_DEPTH = 3;
/** How many levels below each reply come with a page of `listReplies`. */
export const REPLIES_DEPTH = 2;

/** Comments per account: 30, refilling over an hour. */
const COMMENT_BUDGET: RateLimitConfig = { burst: 30, perSecond: 30 / 3600 };

export type CommentAuthor =
  | { kind: 'author'; name: string }
  | { kind: 'alias'; alias: string }
  | { kind: 'account'; handle: string; realName: string | null; institutions: string[]; bot: boolean };

export interface CommentView {
  id: string;
  /** The comment it answers; null on a top-level comment. */
  parentId: string | null;
  /** As written; `null` once removed. */
  body: string | null;
  /** The body rendered for this viewer; `null` once removed. */
  html: string | null;
  createdAt: Date;
  removed: boolean;
  /** Direct replies to it, removed ones included. */
  replyCount: number;
  /** The names `@`-mentioned in the body that resolve on this paper, in order of first mention. */
  mentions: string[];
  /** The page's commit (hex) it was written against: the head when it was posted; null before the first. */
  pageCommit: string | null;
  /** Commits to the page since then: 0 while the comment is about the page as it stands. */
  editsSince: number;
  author: CommentAuthor & {
    /** True when the viewer wrote it. Lets a client say "you" without revealing anyone else. */
    isYou: boolean;
  };
}

/** Who is reading, as the comment box needs it. */
export interface CommentViewer {
  /** Verified (or a bot): may post. */
  canComment: boolean;
  handle: string;
  /** Their alias on this paper; null until they first comment anonymously on it. */
  alias: string | null;
  /** Their name on the paper when they are one of its confirmed authors: their comments carry it. */
  authorName: string | null;
}

export async function postComment(
  input: { paperId: string; account: Account; body: string; parentId?: string | null; anonymous?: boolean },
  database: Database = getDb(),
): Promise<CommentView> {
  const body = input.body.trim();
  if (body.length === 0 || body.length > MAX_COMMENT_LENGTH) {
    throw new ApiError(400, 'validation_error', `a comment is 1–${MAX_COMMENT_LENGTH} characters`);
  }
  const accountId = input.account.id;
  const parentId = input.parentId ?? null;
  if (parentId) {
    const [parent] = await database
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.id, parentId), eq(comments.paperId, input.paperId)));
    if (!parent) throw new ApiError(404, 'not_found', `no comment ${parentId} on this paper`);
  }
  const anonymous = input.anonymous ?? false;
  if (anonymous && (await authorNameOn(input.paperId, accountId, database)) !== null) {
    throw new ApiError(403, 'forbidden', 'you are an author of this paper, so your comments on it carry your name');
  }
  const budget = await consume(`comment:${accountId}`, COMMENT_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many comments from this account; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
  if (anonymous) await ensureAlias(input.paperId, accountId, database);
  const mentioned = await resolveMentions(input.paperId, mentionedNames(body), database);
  const row = await database.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(comments)
      .values({
        paperId: input.paperId,
        accountId,
        parentId,
        body,
        anonymous,
        head: sql`(select head from page_refs where page_id = ${input.paperId}::uuid)`,
      })
      .returning({ id: comments.id });
    const recipients = [...new Set(mentioned.values())].filter((id) => id !== accountId);
    if (recipients.length > 0) {
      await tx.insert(commentMentions).values(recipients.map((id) => ({ commentId: inserted.id, accountId: id })));
    }
    return inserted;
  });
  const [view] = await decorate(await rowsWhere(eq(comments.id, row.id), database), accountId, database);
  return view;
}

/** The confirmed author's name on the paper, or null. */
async function authorNameOn(paperId: string, accountId: string, database: Database): Promise<string | null> {
  const [claim] = await database
    .select({ name: authorClaims.authorName })
    .from(authorClaims)
    .where(
      and(
        eq(authorClaims.paperId, paperId),
        eq(authorClaims.accountId, accountId),
        eq(authorClaims.status, 'confirmed'),
      ),
    );
  return claim?.name ?? null;
}

/**
 * Which accounts `names` (from `mentionedNames`) mention on this paper: an alias here, else a handle chosen
 * by its account. Name → account id; names that are neither are absent.
 */
async function resolveMentions(paperId: string, names: string[], database: Database): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const [aliases, handles] = await Promise.all([
    database
      .select({ name: commentAliases.alias, accountId: commentAliases.accountId })
      .from(commentAliases)
      .where(and(eq(commentAliases.paperId, paperId), inArray(commentAliases.alias, names))),
    database
      .select({ name: accounts.handle, accountId: accounts.id })
      .from(accounts)
      .where(and(inArray(accounts.handle, names), isNotNull(accounts.profileCompletedAt))),
  ]);
  return new Map([...handles, ...aliases].map((r) => [r.name, r.accountId]));
}

/**
 * The account's alias on the paper, made if it has none. Two clashes are possible and both are a unique
 * index's to decide: the same account commenting twice at once (the first insert wins, the second reads it
 * back) and another account holding the alias drawn (draw again).
 */
async function ensureAlias(paperId: string, accountId: string, database: Database): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [existing] = await database
      .select({ alias: commentAliases.alias })
      .from(commentAliases)
      .where(and(eq(commentAliases.paperId, paperId), eq(commentAliases.accountId, accountId)));
    if (existing) return existing.alias;
    await database.insert(commentAliases).values({ paperId, accountId, alias: randomAlias() }).onConflictDoNothing();
  }
  throw new Error(`could not draw a free comment alias on paper ${paperId}`);
}

const PG_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(key: { t: string; id: string }): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { t: string; id: string } | null {
  if (cursor === undefined) return null;
  try {
    const key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (PG_TS.test(key?.t) && UUID.test(key?.id)) return { t: key.t, id: key.id };
  } catch {
    /* fall through */
  }
  throw new ApiError(400, 'validation_error', 'invalid cursor');
}

const commentColumns = {
  id: comments.id,
  paperId: comments.paperId,
  parentId: comments.parentId,
  accountId: comments.accountId,
  body: comments.body,
  anonymous: comments.anonymous,
  removedAt: comments.removedAt,
  createdAt: comments.createdAt,
  // At the column's microseconds, for a cursor: a JS Date would round them away.
  ts: sql<string>`to_char(${comments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  handle: accounts.handle,
  realName: accounts.realName,
  showInstitution: accounts.showInstitution,
  institutions: accounts.institutions,
  isBot: accounts.isBot,
  // Uses comments_parent_created_idx. `r` is the reply; the outer row is `comments`.
  replyCount: sql<number>`(select count(*)::int from comments r where r.parent_id = ${comments.id})`,
  head: comments.head,
  // Commits on the page after the one the comment was written against, by page_revisions' primary key.
  editsSince: sql<number>`(select count(*)::int from page_revisions pr where pr.page_id = ${comments.paperId}
    and pr.seq > coalesce((select h.seq from page_revisions h where h.page_id = ${comments.paperId}
      and h.oid = ${comments.head}), 0))`,
};

type CommentRow = {
  id: string;
  paperId: string;
  parentId: string | null;
  accountId: string;
  body: string;
  anonymous: boolean;
  removedAt: Date | null;
  createdAt: Date;
  ts: string;
  handle: string;
  realName: string | null;
  showInstitution: boolean;
  institutions: string[];
  isBot: boolean;
  replyCount: number;
  head: Buffer | null;
  editsSince: number;
};

function rowsWhere(where: ReturnType<typeof eq>, database: Database): Promise<CommentRow[]> {
  return database
    .select(commentColumns)
    .from(comments)
    .innerJoin(accounts, eq(accounts.id, comments.accountId))
    .where(where)
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/**
 * A page of top-level comments, newest first and keyset-paginated, and in `replies` a preview of the replies
 * under them ({@link previewTree}). `total` counts every comment on the paper, replies included, removed ones
 * not.
 */
export async function listComments(
  paperId: string,
  q: { cursor?: string; limit: number; viewer?: Account | null },
  database: Database = getDb(),
): Promise<{
  comments: CommentView[];
  replies: CommentView[];
  nextCursor: string | null;
  total: number;
  viewer: CommentViewer | null;
}> {
  const before = decodeCursor(q.cursor);
  const [rows, [{ total }]] = await Promise.all([
    database
      .select(commentColumns)
      .from(comments)
      .innerJoin(accounts, eq(accounts.id, comments.accountId))
      .where(
        and(
          eq(comments.paperId, paperId),
          isNull(comments.parentId),
          before
            ? sql`(${comments.createdAt}, ${comments.id}) < (${before.t}::timestamptz, ${before.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(q.limit + 1),
    database
      .select({ total: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(eq(comments.paperId, paperId), isNull(comments.removedAt))),
  ]);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > q.limit && last ? encodeCursor({ t: last.ts, id: last.id }) : null;
  const replies = await previewTree(
    page.map((r) => r.id),
    LIST_DEPTH,
    database,
  );
  const viewerId = q.viewer?.id ?? null;
  const views = await decorate([...page, ...replies], viewerId, database);
  return {
    comments: views.slice(0, page.length),
    replies: views.slice(page.length),
    nextCursor,
    total,
    viewer: q.viewer ? await commentViewer(paperId, q.viewer, database) : null,
  };
}

export async function commentViewer(
  paperId: string,
  account: Account,
  database: Database = getDb(),
): Promise<CommentViewer> {
  const [[alias], authorName] = await Promise.all([
    database
      .select({ alias: commentAliases.alias })
      .from(commentAliases)
      .where(and(eq(commentAliases.paperId, paperId), eq(commentAliases.accountId, account.id))),
    authorNameOn(paperId, account.id, database),
  ]);
  return {
    canComment: account.isBot || account.verifiedAt !== null,
    handle: account.handle,
    alias: alias?.alias ?? null,
    authorName,
  };
}

/**
 * The replies under these comments that a preview shows: the first {@link REPLY_PREVIEW} replies to each,
 * oldest first, and so on `depth` levels down. One recursive query; flat, oldest first.
 */
async function previewTree(parentIds: string[], depth: number, database: Database): Promise<CommentRow[]> {
  if (parentIds.length === 0 || depth < 1) return [];
  const ids = sql.join(
    parentIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // Each step takes the first few replies of every comment found so far, by comments_parent_created_idx.
  const tree = sql`
    with recursive tree (id, depth) as (
      select id, 1 from (
        select id, row_number() over (partition by parent_id order by created_at, id) as rn
        from comments where parent_id in (${ids})
      ) first where rn <= ${REPLY_PREVIEW}
      union all
      select next.id, tree.depth + 1 from tree
      cross join lateral (
        select id from comments where parent_id = tree.id order by created_at, id limit ${REPLY_PREVIEW}
      ) next
      where tree.depth < ${depth}
    )
    select id from tree`;
  return rowsWhere(sql`${comments.id} in (${tree})`, database);
}

/**
 * A comment's direct replies, oldest first, after the reply `after` (the last one the client has), `limit` of
 * them, and a preview of the replies under each ({@link REPLIES_DEPTH} levels). Flat: `parentId` makes the
 * tree. Whether more remain is the comment's `replyCount` against what is loaded.
 */
export async function listReplies(
  commentId: string,
  q: { after?: string; limit: number; viewer?: Account | null },
  database: Database = getDb(),
): Promise<CommentView[]> {
  const [parent] = await database.select({ id: comments.id }).from(comments).where(eq(comments.id, commentId));
  if (!parent) throw new ApiError(404, 'not_found', `no comment ${commentId}`);
  if (q.after) {
    const [after] = await database
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.id, q.after), eq(comments.parentId, commentId)));
    if (!after) throw new ApiError(400, 'validation_error', '`after` is not a reply to this comment');
  }
  const page: CommentRow[] = await database
    .select(commentColumns)
    .from(comments)
    .innerJoin(accounts, eq(accounts.id, comments.accountId))
    .where(
      and(
        eq(comments.parentId, commentId),
        q.after
          ? sql`(${comments.createdAt}, ${comments.id}) > (select c.created_at, c.id from comments c where c.id = ${q.after}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(q.limit);
  const below = await previewTree(
    page.map((r) => r.id),
    REPLIES_DEPTH,
    database,
  );
  return decorate([...page, ...below], q.viewer?.id ?? null, database);
}

/** Removes one of the account's own comments: its words go, its place in the thread stays. */
export async function removeComment(accountId: string, commentId: string, database: Database = getDb()): Promise<void> {
  const removed = await database
    .update(comments)
    .set({ removedAt: new Date() })
    .where(and(eq(comments.id, commentId), eq(comments.accountId, accountId), isNull(comments.removedAt)))
    .returning({ id: comments.id });
  if (removed.length === 0) throw new ApiError(404, 'not_found', 'you have no comment with that id');
}

/** A draft as it would be shown on the paper, for the comment box's preview. */
export async function previewComment(
  paperId: string,
  body: string,
  viewer: Account,
  database: Database = getDb(),
): Promise<{ html: string; mentions: string[] }> {
  const names = mentionedNames(body);
  const resolved = await resolveMentions(paperId, names, database);
  const known = new Set(resolved.keys());
  return { html: renderComment(body, { known }), mentions: names.filter((n) => known.has(n)) };
}

/** The names a viewer goes by on a paper, whose mentions their HTML sets apart. */
async function viewerNames(
  viewerId: string | null,
  paperIds: string[],
  database: Database,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!viewerId) return out;
  const [[account], aliases] = await Promise.all([
    database.select({ handle: accounts.handle }).from(accounts).where(eq(accounts.id, viewerId)),
    database
      .select({ paperId: commentAliases.paperId, alias: commentAliases.alias })
      .from(commentAliases)
      .where(and(eq(commentAliases.accountId, viewerId), inArray(commentAliases.paperId, paperIds))),
  ]);
  for (const paperId of paperIds) out.set(paperId, new Set(account ? [account.handle] : []));
  for (const a of aliases) out.get(a.paperId)?.add(a.alias);
  return out;
}

/** Comment rows, on any papers, as a reader sees them. */
async function decorate(rows: CommentRow[], viewerId: string | null, database: Database): Promise<CommentView[]> {
  if (rows.length === 0) return [];
  const paperIds = [...new Set(rows.map((r) => r.paperId))];
  const authorIds = [...new Set(rows.map((r) => r.accountId))];
  const [aliases, claims, you, resolved] = await Promise.all([
    database
      .select({ paperId: commentAliases.paperId, accountId: commentAliases.accountId, alias: commentAliases.alias })
      .from(commentAliases)
      .where(and(inArray(commentAliases.paperId, paperIds), inArray(commentAliases.accountId, authorIds))),
    database
      .select({ paperId: authorClaims.paperId, accountId: authorClaims.accountId, name: authorClaims.authorName })
      .from(authorClaims)
      .where(
        and(
          inArray(authorClaims.paperId, paperIds),
          inArray(authorClaims.accountId, authorIds),
          eq(authorClaims.status, 'confirmed'),
        ),
      ),
    viewerNames(viewerId, paperIds, database),
    Promise.all(
      paperIds.map(async (paperId) => {
        const names = [
          ...new Set(rows.filter((r) => r.paperId === paperId && !r.removedAt).flatMap((r) => mentionedNames(r.body))),
        ];
        return [paperId, new Set((await resolveMentions(paperId, names, database)).keys())] as const;
      }),
    ).then((entries) => new Map(entries)),
  ]);
  const key = (paperId: string, accountId: string) => `${paperId}:${accountId}`;
  const aliasOf = new Map(aliases.map((a) => [key(a.paperId, a.accountId), a.alias]));
  const authorOf = new Map(claims.map((c) => [key(c.paperId, c.accountId), c.name]));

  return rows.map((r) => {
    const removed = r.removedAt !== null;
    const known = resolved.get(r.paperId) ?? new Set<string>();
    const mentions = removed ? [] : mentionedNames(r.body).filter((n) => known.has(n));
    return {
      id: r.id,
      parentId: r.parentId,
      body: removed ? null : r.body,
      html: removed ? null : renderComment(r.body, { known, you: you.get(r.paperId) }),
      createdAt: r.createdAt,
      removed,
      replyCount: r.replyCount,
      mentions,
      pageCommit: r.head ? r.head.toString('hex') : null,
      editsSince: r.editsSince,
      author: {
        ...authorFor(r, aliasOf.get(key(r.paperId, r.accountId)), authorOf.get(key(r.paperId, r.accountId))),
        isYou: viewerId === r.accountId,
      },
    };
  });
}

function authorFor(r: CommentRow, alias: string | undefined, authorName: string | undefined): CommentAuthor {
  // An anonymous comment from before a claim stays anonymous: naming it now would unmask it.
  if (r.anonymous) {
    if (alias === undefined) throw new Error(`anonymous comment ${r.id} has no alias`);
    return { kind: 'alias', alias };
  }
  // A confirmed author's handle never appears on their paper (DESIGN.md §5.3).
  if (authorName !== undefined) return { kind: 'author', name: authorName };
  return {
    kind: 'account',
    handle: r.handle,
    realName: r.realName,
    institutions: r.showInstitution ? r.institutions : [],
    bot: r.isBot,
  };
}

/** A comment that mentions the caller, for their inbox (`GET /api/v1/me/mentions`). */
export interface MentionView {
  comment: CommentView;
  paper: { title: string; path: string };
}

/**
 * The comments that `@`-mention an account, newest first, keyset-paginated, optionally only those after
 * `since`. Read from `comment_mentions`, so a mention is what the page highlighted when it was posted. Removed
 * comments drop out.
 */
export async function listMentions(
  accountId: string,
  q: { cursor?: string; since?: string; limit: number },
  database: Database = getDb(),
): Promise<{ mentions: MentionView[]; nextCursor: string | null }> {
  const before = decodeCursor(q.cursor);
  const rows = await database
    .select(commentColumns)
    .from(commentMentions)
    .innerJoin(comments, eq(comments.id, commentMentions.commentId))
    .innerJoin(accounts, eq(accounts.id, comments.accountId))
    .where(
      and(
        eq(commentMentions.accountId, accountId),
        isNull(comments.removedAt),
        q.since ? sql`${comments.createdAt} > ${q.since}::timestamptz` : undefined,
        before
          ? sql`(${comments.createdAt}, ${comments.id}) < (${before.t}::timestamptz, ${before.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const [views, paperOf] = await Promise.all([
    decorate(page, accountId, database),
    papersOf(
      page.map((r) => r.paperId),
      database,
    ),
  ]);
  return {
    mentions: page.map((r, i) => ({ comment: views[i], paper: paperOf.get(r.paperId)! })),
    nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.ts, id: last.id }) : null,
  };
}

/** Papers' titles and where their discussions are read. */
async function papersOf(ids: string[], database: Database): Promise<Map<string, { title: string; path: string }>> {
  const paperIds = [...new Set(ids)];
  if (paperIds.length === 0) return new Map();
  const [titles, identifiers] = await Promise.all([
    database.select({ id: papers.id, title: papers.title }).from(papers).where(inArray(papers.id, paperIds)),
    database
      .select({ paperId: paperIdentifiers.paperId, scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
      .from(paperIdentifiers)
      .where(inArray(paperIdentifiers.paperId, paperIds)),
  ]);
  return new Map(
    titles.map((p) => {
      const id = canonicalPaperId(identifiers.filter((i) => i.paperId === p.id));
      return [p.id, { title: p.title, path: `${id ? paperPath(id) : '/'}#discussion` }];
    }),
  );
}

/** One comment as a reader who isn't its author sees it, with its paper; `null` if there is none. */
export async function getComment(commentId: string, database: Database = getDb()): Promise<MentionView | null> {
  const rows = await rowsWhere(eq(comments.id, commentId), database);
  if (rows.length === 0) return null;
  const [[comment], paperOf] = await Promise.all([
    decorate(rows, null, database),
    papersOf([rows[0].paperId], database),
  ]);
  return { comment, paper: paperOf.get(rows[0].paperId)! };
}
