'use client';

import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import { ui } from '@/components/ui';
import { aliasName } from '@/lib/aliases';
import { COMMENT_PAGE, MAX_COMMENT_LENGTH, REPLY_PAGE } from '@/lib/comments';
import type { PaperId } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';
import type * as S from '@/server/api/schemas';

type CommentList = z.output<typeof S.CommentList>;
type Comment = z.output<typeof S.Comment>;
type Viewer = NonNullable<CommentList['viewer']>;

const MESSAGES: Record<string, string> = {
  not_verified: 'Confirm an institutional address to comment.',
  rate_limited: 'Too many comments. Wait a while.',
};

async function errorText(res: Response | null, fallback: string): Promise<string> {
  const e = await res?.json().catch(() => null);
  return MESSAGES[e?.error?.code] ?? e?.error?.message ?? fallback;
}

/** What a comment's text may contain, for the line under the editor. */
const MARKDOWN_HINT = 'Markdown and TeX math ($…$, $$…$$) work.';

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const [n, unit] =
    s < 3600
      ? [s / 60, 'minute']
      : s < 86_400
        ? [s / 3600, 'hour']
        : s < 30 * 86_400
          ? [s / 86_400, 'day']
          : s < 365 * 86_400
            ? [s / (30 * 86_400), 'month']
            : [s / (365 * 86_400), 'year'];
  const k = Math.floor(n);
  return `${k} ${unit}${k === 1 ? '' : 's'} ago`;
}

/** How the viewer's next comment will be signed. */
function signedAs(viewer: Viewer, anonymous: boolean): string {
  if (viewer.authorName) return `${viewer.authorName}, as an author of this paper`;
  if (anonymous) return viewer.alias ? aliasName(viewer.alias) : 'an anonymous alias of its own on this paper';
  return `@${viewer.handle}`;
}

/**
 * The discussion under a paper (`server/comments`). A client island, since the page is the same cached HTML
 * for every reader: it loads on mount. Each comment is signed as DESIGN.md §5.3 says: by handle, by an alias on
 * this paper when posted anonymously, or by an author's name on the paper. `@name` mentions an alias or a
 * handle, and mails them.
 *
 * Replies nest, each level indented under the comment it answers. Never read whole: top-level comments come
 * {@link COMMENT_PAGE} at a time with a preview of the replies under them (a flat list the tree is built from
 * by `parentId`), and "more replies" on any comment fetches its next {@link REPLY_PAGE}, each with its own
 * preview.
 */
export function Comments({ paper, path }: { paper: PaperId; path: string }) {
  const base = `/api/v1/comments?scheme=${paper.scheme}&value=${encodeURIComponent(paper.value)}&limit=${COMMENT_PAGE}`;
  const [pages, setPages] = useState<CommentList[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // Replies fetched by "more replies" or posted here, over the loaded pages.
  const [extra, setExtra] = useState<Map<string, Comment>>(new Map());
  // Replies posted here, which can land past a gap: "more replies" must not continue after one.
  const [posted, setPosted] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    const res = await fetch(base, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return setFailed(true);
    setFailed(false);
    setPages([await res.json()]);
    setExtra(new Map());
    setPosted(new Set());
  }, [base]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading the discussion is this island's job
    void reload();
  }, [reload]);

  async function more() {
    const cursor = pages.at(-1)?.nextCursor;
    if (!cursor) return;
    setBusy(true);
    const res = await fetch(`${base}&cursor=${encodeURIComponent(cursor)}`).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      const page: CommentList = await res.json();
      setPages((ps) => [...ps, page]);
    }
  }

  const first = pages[0];
  const viewer = first?.viewer ?? null;
  const threads = pages.flatMap((p) => p.comments);
  const known = new Map<string, Comment>();
  for (const p of pages) for (const c of [...p.comments, ...p.replies]) known.set(c.id, c);
  for (const [id, c] of extra) known.set(id, c);
  const children = new Map<string, Comment[]>();
  for (const c of known.values()) {
    if (c.parentId) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  }
  for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const add = (cs: Comment[]) =>
    setExtra((m) => {
      const next = new Map(m);
      for (const c of cs) next.set(c.id, c);
      return next;
    });

  const tree: Tree = {
    paper,
    viewer,
    children: (id) => children.get(id) ?? [],
    loaded: add,
    posted: (c) => {
      setPosted((xs) => new Set(xs).add(c.id));
      add([c]);
    },
    isPosted: (id) => posted.has(id),
    replaced: (c) => add([c]),
  };

  return (
    <section id="discussion">
      <h2 className={ui.groupHeading}>Discussion{first ? ` (${first.total})` : ''}</h2>
      {!first ? (
        <p className={ui.fine}>{failed ? 'The discussion could not be loaded.' : 'Loading the discussion…'}</p>
      ) : viewer?.canComment ? (
        <CommentForm paper={paper} viewer={viewer} onPosted={() => void reload()} />
      ) : (
        <p className={`${ui.fine} font-sans`}>
          {viewer ? (
            <>
              <a href="/profile#affiliations">Confirm an institutional address</a> to comment.
            </>
          ) : (
            <>
              <a href={authHref('/signin', `${path}#discussion`)} rel="nofollow">
                Sign in
              </a>{' '}
              to comment.
            </>
          )}
        </p>
      )}

      {first && threads.length === 0 && (
        <p className={ui.empty}>No comments yet. Questions, critique and pointers to related work are welcome.</p>
      )}

      {threads.map((t) => (
        // One rule under the whole thread, so its replies read as part of it.
        <div key={t.id} className="border-b border-dotted border-rule-strong">
          <Thread c={extra.get(t.id) ?? t} tree={tree} />
        </div>
      ))}

      {pages.at(-1)?.nextCursor && (
        <button
          type="button"
          className={`mt-3 ${ui.btn({ inline: true, ghost: true })}`}
          disabled={busy}
          onClick={more}
        >
          Load more comments
        </button>
      )}
    </section>
  );
}

/** What every comment in the tree needs from the discussion. */
interface Tree {
  paper: PaperId;
  viewer: Viewer | null;
  /** The loaded direct replies to a comment, oldest first. */
  children: (id: string) => Comment[];
  /** Replies fetched by "more replies". */
  loaded: (cs: Comment[]) => void;
  /** A reply posted here. */
  posted: (c: Comment) => void;
  isPosted: (id: string) => boolean;
  /** A comment changed here (removed). */
  replaced: (c: Comment) => void;
}

/** A comment and, indented under it, its replies — each a `Thread` of its own, so every level is indented again. */
function Thread({ c, tree }: { c: Comment; tree: Tree }) {
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const replies = tree.children(c.id);
  const remaining = Math.max(0, c.replyCount - replies.length);

  async function more() {
    setBusy(true);
    setNote(null);
    // Continue after the last reply that came from the server: one posted here may sit past a gap.
    const after = replies.filter((r) => !tree.isPosted(r.id)).at(-1);
    const res = await fetch(
      `/api/v1/comments/${c.id}/replies?limit=${REPLY_PAGE}${after ? `&after=${after.id}` : ''}`,
    ).catch(() => null);
    setBusy(false);
    if (!res?.ok) return setNote(await errorText(res, 'Could not load replies.'));
    tree.loaded((await res.json()).replies);
  }

  return (
    <>
      <CommentItem
        c={c}
        onReply={tree.viewer?.canComment && !c.removed ? () => setReplying(true) : undefined}
        onRemoved={() => tree.replaced({ ...c, removed: true, body: null, html: null, mentions: [] })}
      />
      {(replies.length > 0 || replying || remaining > 0 || note) && (
        <div className="mb-2 ml-1.5 border-l-2 border-rule-strong pl-5 narrow:pl-3">
          {replies.map((r) => (
            <Thread key={r.id} c={r} tree={tree} />
          ))}
          {remaining > 0 && (
            <button
              type="button"
              className="cursor-pointer py-1.5 font-sans text-xs text-muted underline disabled:opacity-50"
              disabled={busy}
              onClick={more}
            >
              {remaining === 1 ? '1 more reply' : `${remaining} more replies`}
            </button>
          )}
          {note && <div className={ui.note(false)}>{note}</div>}
          {replying && tree.viewer && (
            <div className="py-2">
              <CommentForm
                paper={tree.paper}
                viewer={tree.viewer}
                parentId={c.id}
                placeholder={`Reply to ${authorLabel(c.author)}`}
                autoFocus
                onPosted={(r) => {
                  tree.posted(r);
                  setReplying(false);
                }}
                onCancel={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function authorLabel(a: Comment['author']): string {
  if (a.kind === 'author') return a.name;
  if (a.kind === 'alias') return aliasName(a.alias);
  return a.realName ?? `@${a.handle}`;
}

/** The editor for a new comment, or with `parentId` a reply. */
function CommentForm({
  paper,
  viewer,
  parentId,
  placeholder = 'A question, a critique, a pointer to related work…',
  autoFocus,
  onPosted,
  onCancel,
}: {
  paper: PaperId;
  viewer: Viewer;
  parentId?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onPosted: (c: Comment) => void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState('');
  // An account that has commented anonymously here starts that way again: it is how this paper knows it.
  const [anonymous, setAnonymous] = useState(viewer.alias !== null && !viewer.authorName);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const empty = body.trim().length === 0;

  async function togglePreview() {
    if (preview !== null) return setPreview(null);
    setBusy(true);
    setError(null);
    const res = await fetch('/api/v1/comments/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paper, body }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) setPreview((await res.json()).html);
    else setError(await errorText(res, 'Could not preview.'));
  }

  async function post() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/v1/comments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paper, body, parentId, anonymous: anonymous && !viewer.authorName }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setBody('');
      setPreview(null);
      onPosted(await res.json());
    } else {
      setError(await errorText(res, 'Could not post.'));
    }
  }

  return (
    <div className="font-sans">
      {preview !== null ? (
        <div className="min-h-[70px] border border-dashed border-rule bg-card p-2">
          <div className="md comment-md" dangerouslySetInnerHTML={{ __html: preview }} />
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={MAX_COMMENT_LENGTH}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className="min-h-[70px] w-full border border-rule bg-white p-2 text-sm narrow:text-base"
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className={ui.fine}>
          Shown as {signedAs(viewer, anonymous)}. @name mentions a handle, or an alias here, and emails them.{' '}
          {MARKDOWN_HINT}
        </span>
        <span className="flex items-center gap-2">
          {!viewer.authorName && (
            <label className="mt-2 flex items-center gap-1 text-xs text-muted">
              <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
              anonymous
            </label>
          )}
          {onCancel && (
            <button className={ui.btn({ inline: true, ghost: true })} disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            className={ui.btn({ inline: true, ghost: true })}
            disabled={busy || (empty && preview === null)}
            onClick={togglePreview}
          >
            {preview !== null ? 'Edit' : 'Preview'}
          </button>
          <button className={ui.btn({ inline: true })} disabled={busy || empty} onClick={post}>
            {parentId ? 'Reply' : 'Post'}
          </button>
        </span>
      </div>
      {error && <div className={ui.note(false)}>{error}</div>}
    </div>
  );
}

function Byline({ author }: { author: Comment['author'] }) {
  const you = author.isYou && <span className="text-faint"> (you)</span>;
  if (author.kind === 'author') {
    return (
      <span>
        <span className="text-ink">{author.name}</span>
        <span className={ui.badge}>author</span>
        {you}
      </span>
    );
  }
  if (author.kind === 'alias') {
    return (
      <span>
        <span className="text-ink">{aliasName(author.alias)}</span>
        {you}
      </span>
    );
  }
  return (
    <span>
      {author.realName && <span className="text-ink">{author.realName} </span>}
      <span className={author.realName ? '' : 'text-ink'}>@{author.handle}</span>
      {author.bot && <span className={ui.badge}>bot</span>}
      {author.institutions.length > 0 && <span>, {author.institutions.join(', ')}</span>}
      {you}
    </span>
  );
}

function CommentItem({
  c,
  onReply,
  onRemoved,
}: {
  c: Comment;
  /** Opens the thread's reply form; absent when the viewer cannot comment. */
  onReply?: () => void;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function remove() {
    if (!window.confirm('Remove this comment? Its replies stay.')) return;
    setBusy(true);
    setNote(null);
    const res = await fetch(`/api/v1/comments/${c.id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (res?.ok) onRemoved();
    else setNote(await errorText(res, 'Could not remove it.'));
  }

  return (
    <div className="py-2.5" id={`comment-${c.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 font-sans text-[13px] text-muted">
        <Byline author={c.author} />
        <span title={new Date(c.createdAt).toISOString().slice(0, 16).replace('T', ' ')}>{ago(c.createdAt)}</span>
      </div>
      {c.removed ? (
        <p className="mt-1 text-sm text-muted italic">Removed by its author.</p>
      ) : (
        <div className="md comment-md mt-1" dangerouslySetInnerHTML={{ __html: c.html ?? '' }} />
      )}
      {!c.removed && (onReply || c.author.isYou) && (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-sans text-xs text-muted">
          {onReply && (
            <button type="button" className="cursor-pointer underline" onClick={onReply}>
              reply
            </button>
          )}
          {c.author.isYou && (
            <button
              type="button"
              className="cursor-pointer underline disabled:opacity-50"
              disabled={busy}
              onClick={remove}
            >
              remove
            </button>
          )}
        </div>
      )}
      {note && <div className={ui.note(false)}>{note}</div>}
    </div>
  );
}
