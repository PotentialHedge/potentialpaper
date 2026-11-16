import { headers as nextHeaders } from 'next/headers';
import type { z } from 'zod';
import type { Account, Affiliation } from '@/db/schema';
import { updateProfile } from '../accounts';
import { addAffiliation, listAffiliations, removeAffiliation, verifyAffiliation } from '../affiliations';
import { authenticate, requireAuth, requireSession, requireVerified, viewerFromHeaders, type Principal } from '../auth';
import { cloneAddresses } from '../pages/clone';
import { commitWorkspace, readBlob, readWorkspace, rebaseWorkspace, storeWorkspaceFile } from '../workspace';
import { issueAgentCode, redeemAgentCode, requestAgentCode } from '../agent-codes';
import { uploadAgentFile } from '../agent-files';
import { agentPostsOf, createAgentPost, removeAgentPost, type PresentedAgentPost } from '../agent-posts';
import {
  listComments,
  listMentions,
  listReplies,
  postComment,
  previewComment,
  removeComment,
  type CommentView,
} from '../comments';
import { mailMentions } from '../mentions';
import { hasLiveToken, listTokens, mintToken, revokeToken } from '../tokens';
import { addSshKey, listSshKeys, removeSshKey } from '../ssh-keys';
import { previewDemoSources } from '../demos/attach';
import { snapshotDemo } from '../demos/snapshot';
import { demoUrl } from '@/lib/demos';
import { ownClaim, requestClaim, withdrawClaim } from '../claims';
import { revertCommit, type Actor, type CommitResult } from '../pages/commit';
import { renderHtml } from '../pages/html';
import { renderMarkdown } from '../pages/markdown';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { refreshPaperPages } from '../pages/refresh';
import { fetchPdf, storeFile } from '../files';
import { mergeFoundVersions, setVersions, versionsAt } from '../versions';
import { lookUpVersions } from '../version-sources';
import { consume, type RateLimitConfig } from '../ratelimit';
import { sortVersions, type VersionPdf } from '@/lib/versions';
import { setFirstPassword, startOnboarding } from '../onboarding';
import { canonicalPaperId, paperPath, parsePaperId } from '@/lib/paper-ids';
import { findPaper, lookupPaper } from '../papers';
import { searchPapers } from '../search';
import { siteUrl } from '../site';
import { ApiError } from './errors';
import { parseBody, parseParam, parseQuery, respond, route, toIso, toIsoOrNull } from './http';
import * as S from './schemas';

/** The `/api/v1` handlers; the route files only re-export them. */

function presentMe(a: Account) {
  return {
    id: a.id,
    handle: a.handle,
    realName: a.realName,
    showInstitution: a.showInstitution,
    institutions: a.institutions,
    verified: a.verifiedAt !== null,
    profileComplete: a.profileCompletedAt !== null,
    mentionMail: a.mentionMail,
  };
}

function presentAffiliation(a: Affiliation) {
  return {
    id: a.id,
    email: a.email,
    institutionName: a.institutionName,
    primary: a.isPrimary,
    verifiedAt: toIsoOrNull(a.verifiedAt),
    codeExpiresAt: toIsoOrNull(a.codeExpiresAt),
    createdAt: toIso(a.createdAt),
  };
}

export const onboarding = route(async (req) => {
  await startOnboarding(await parseBody(req, S.OnboardingBody));
  return respond(S.Accepted, { status: 'accepted' }, { status: 202 });
});

/**
 * Who the browser is, for the navbar: pages stay the same HTML for every reader so that the edge can
 * cache them, and this fills in the viewer afterwards. Answers 200 with `null` for a visitor. No rate
 * limit, as for page renders.
 */
export const viewer = route(async () => {
  const seen = await viewerFromHeaders(await nextHeaders());
  return respond(S.Viewer, {
    viewer: seen && {
      handle: seen.account.handle,
      isAdmin: seen.isAdmin,
      profileComplete: seen.account.profileCompletedAt !== null,
      hasAgent: await hasLiveToken(seen.account.id),
    },
  });
});

export const getMe = route(async (req) => {
  const principal = await requireAuth(req);
  return respond(S.Me, presentMe(principal.account), { principal });
});

export const patchMe = route(async (req) => {
  const principal = await requireAuth(req);
  const updated = await updateProfile(principal.account, await parseBody(req, S.MePatch));
  return respond(S.Me, presentMe(updated), { principal });
});

export const setPassword = route(async (req) => {
  const principal = await requireAuth(req);
  const { password } = await parseBody(req, S.PasswordBody);
  await setFirstPassword(req.headers, password);
  return respond(S.Ok, { status: 'ok' }, { principal });
});

export const getAffiliations = route(async (req) => {
  const principal = await requireAuth(req);
  const rows = await listAffiliations(principal.account.id);
  return respond(S.AffiliationList, { affiliations: rows.map(presentAffiliation) }, { principal });
});

export const postAffiliation = route(async (req) => {
  const principal = await requireAuth(req);
  const { email } = await parseBody(req, S.AffiliationBody);
  const row = await addAffiliation({ account: principal.account, email });
  return respond(S.Affiliation, presentAffiliation(row), { status: 201, principal });
});

export const verifyAffiliationRoute = route(async (req, params) => {
  const principal = await requireAuth(req);
  const id = parseParam(params.id, S.IdParam, 'id');
  const { code } = await parseBody(req, S.AffiliationCodeBody);
  const row = await verifyAffiliation({ accountId: principal.account.id, id, code });
  return respond(S.Affiliation, presentAffiliation(row), { principal });
});

export const deleteAffiliation = route(async (req, params) => {
  const principal = await requireAuth(req);
  const id = parseParam(params.id, S.IdParam, 'id');
  await removeAffiliation({ accountId: principal.account.id, id });
  return respond(S.Ok, { status: 'ok' }, { principal });
});

/** Empty, which no identifier is, when a segment is not valid percent-encoding. */
function decodedPath(segments: string[]): string {
  try {
    return segments.map(decodeURIComponent).join('/');
  } catch {
    return '';
  }
}

/** A paper by identifier, in any scheme; the first request for one may fetch it from its source. */
export const getPaper = route(async (_req, params) => {
  const scheme = parseParam(params.scheme, S.PaperSchemeParam, 'scheme');
  const id = parsePaperId(scheme, decodedPath(params.value as string[]));
  if (!id) throw new ApiError(404, 'not_found', 'no paper with that identifier');
  const found = await lookupPaper(id);
  if (found.status === 'missing') throw new ApiError(404, 'not_found', 'no paper with that identifier');
  if (found.status === 'unavailable') {
    throw new ApiError(
      503,
      'source_unavailable',
      'could not reach the source for this paper; try again shortly',
      undefined,
      {
        'Retry-After': String(found.retryAfterSeconds),
      },
    );
  }
  const { paper, identifiers } = found;
  return respond(S.PaperResponse, {
    title: paper.title,
    authors: paper.authors,
    abstract: paper.abstract,
    year: paper.year,
    venue: paper.venue,
    identifiers,
    path: paperPath(canonicalPaperId(identifiers) ?? id),
  });
});

export const search = route(async (req) => {
  const { q, venue, sort, page } = parseQuery(req, S.SearchQuery);
  const limit = 20;
  const { hits, total } = await searchPapers({ q, venue, sort: sort ?? (q ? 'relevance' : 'activity'), page, limit });
  return respond(S.SearchResponse, {
    hits: hits.map(({ scheme, value, ...hit }) => ({ ...hit, path: paperPath({ scheme, value }) })),
    total,
    hasMore: page * limit < total,
  });
});

function actorOf(principal: Principal): Actor {
  return { kind: 'account', accountId: principal.account.id, isAdmin: principal.isAdmin };
}

/** A paper that already has a page here: demos are added from that page, so it exists. */
async function knownPaper(scheme: z.infer<typeof S.PaperSchemeParam>, value: string) {
  const id = parsePaperId(scheme, value);
  const found = id && (await findPaper(id));
  if (!found) throw new ApiError(404, 'not_found', 'no paper with that identifier');
  return found;
}

/**
 * Copies a demo from a public GitHub repo or gist, for the editor to insert into a section as a block.
 * Slow: it downloads the repo. Commits nothing: the block does, with the edit.
 */
export const postDemoSnapshot = route(async (req) => {
  const principal = await requireVerified(req);
  const { url } = await parseBody(req, S.DemoSnapshotBody);
  const snapshot = await snapshotDemo(url);
  return respond(
    S.DemoSnapshotted,
    {
      id: snapshot.id,
      source: snapshot.source,
      commit: snapshot.commit,
      root: snapshot.root,
      url: demoUrl(snapshot.id),
      files: snapshot.fileCount,
      bytes: snapshot.totalBytes,
    },
    { status: 201, principal },
  );
});

function committed(result: CommitResult) {
  return result.status === 'committed'
    ? { head: result.oid, merged: result.merged, changed: true }
    : { head: result.oid, merged: false, changed: false };
}

/** The editor's preview, through the renderer commits use. Signed-in only, as only editors need it. */
export const postRender = route(async (req) => {
  const principal = await requireAuth(req);
  const { content, format } = await parseBody(req, S.RenderBody);
  if (format === 'html') return respond(S.Rendered, { html: renderHtml(content) }, { principal });
  const demos = await previewDemoSources(content);
  return respond(S.Rendered, { html: renderMarkdown(content, 'preview', { demos }) }, { principal });
});

/** Undoes one commit, keeping everything since, as `git revert` does. */
export const postRevert = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, oid, summary, evidence } = await parseBody(req, S.RevertBody);
  const { paper, identifiers } = await knownPaper(id.scheme, id.value);
  const result = await revertCommit(paper.id, oid, actorOf(principal), summary?.trim() || undefined, { evidence });
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.PageCommitted, committed(result), { principal });
});

/** The paper's versions and the commit they were read at, which a change is sent back with. Public. */
export const getVersions = route(async (req) => {
  const { scheme, value } = parseQuery(req, S.PaperQuery);
  const { paper } = await knownPaper(scheme, value);
  const { head, versions } = await versionsAt(paper.id);
  return respond(S.VersionsResponse, { head, versions: sortVersions(versions) });
});

/** Replaces the paper's versions, merged with whatever changed since `baseOid`. */
export const postVersions = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, ...edit } = await parseBody(req, S.VersionsBody);
  const { paper, identifiers } = await knownPaper(id.scheme, id.value);
  const result = await setVersions(paper.id, actorOf(principal), {
    ...edit,
    versions: edit.versions.map((v) => ({
      ...v,
      date: v.date ?? undefined,
      status: v.status ?? undefined,
      decision: v.decision ?? undefined,
      title: v.title ?? undefined,
      abstract: v.abstract ?? undefined,
      url: v.url ?? undefined,
      note: v.note ?? undefined,
    })),
  });
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.PageCommitted, committed(result), { principal });
});

const LOOKUP_BUDGET: RateLimitConfig = { burst: 10, perSecond: 10 / 3600 };

/**
 * Finds the paper's versions on OpenReview and arXiv, copies their PDFs where the license allows, and answers
 * with the page's versions with them folded in. Commits nothing: the editor shows the list to be checked.
 */
export const postVersionsLookup = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, arxiv } = await parseBody(req, S.VersionsLookupBody);
  const { paper, identifiers } = await knownPaper(id.scheme, id.value);
  const budget = await consume(`version-lookup:${principal.account.id}`, LOOKUP_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(429, 'rate_limited', 'too many look-ups; try again later', {
      retryAfterSeconds: budget.retryAfterSeconds,
    });
  }
  const [{ versions: existing }, [current]] = await Promise.all([
    versionsAt(paper.id),
    getDb().select({ pdf: pageCurrent.pdf }).from(pageCurrent).where(eq(pageCurrent.paperId, paper.id)),
  ]);
  const known = new Map<string, VersionPdf>();
  if (current?.pdf) known.set(current.pdf.source, current.pdf);
  const { versions: found, problems } = await lookUpVersions({
    title: paper.title,
    arxiv: arxiv ?? identifiers.find((i) => i.scheme === 'arxiv')?.value ?? null,
    accountId: principal.account.id,
    known,
  });
  return respond(S.VersionsLookup, { versions: mergeFoundVersions(existing, found), problems }, { principal });
});

/**
 * Stores a file that backs up an edit, or a version's PDF: multipart with the file as `file`, or JSON
 * `{ url }` to copy a PDF from an archive or proceedings site. Answers with the address to name it by.
 */
export const postFile = route(async (req) => {
  const principal = await requireVerified(req);
  let stored;
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    const { url } = await parseBody(req, S.FileFetchBody);
    stored = await fetchPdf(principal.account.id, url);
  } else {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      throw new ApiError(400, 'validation_error', 'send a multipart form with the file as `file`, or JSON { url }');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw new ApiError(400, 'validation_error', 'send the file as the form part `file`');
    stored = await storeFile(principal.account.id, Buffer.from(await file.arrayBuffer()), file.name);
  }
  return respond(
    S.StoredFile,
    {
      id: stored.id,
      url: stored.url,
      type: stored.type,
      name: stored.name,
      bytes: stored.bytes,
      sha256: stored.sha256,
    },
    { status: 201, principal },
  );
});

/** The viewer's own claim on the paper. */
export const getClaim = route(async (req) => {
  const principal = await requireAuth(req);
  const { scheme, value } = parseQuery(req, S.PaperQuery);
  const { paper } = await knownPaper(scheme, value);
  return respond(S.OwnClaim, { claim: await ownClaim(paper.id, principal.account.id) }, { principal });
});

/** Asks to be confirmed as one of the paper's authors. An admin decides, for now. */
export const postClaim = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, authorIndex, evidence } = await parseBody(req, S.ClaimBody);
  const { paper } = await knownPaper(id.scheme, id.value);
  const claim = await requestClaim(paper.id, principal.account, { authorIndex, evidence });
  return respond(S.OwnClaim, { claim }, { status: 201, principal });
});

export const deleteClaim = route(async (req) => {
  const principal = await requireAuth(req);
  const { scheme, value } = parseQuery(req, S.PaperQuery);
  const { paper } = await knownPaper(scheme, value);
  await withdrawClaim(paper.id, principal.account.id);
  return respond(S.OwnClaim, { claim: null }, { principal });
});

/** Mails the person a code for their agent. Anonymous, and the same answer whether or not they have an account. */
export const postAgentCode = route(async (req) => {
  const { email } = await parseBody(req, S.AgentCodeBody);
  await requestAgentCode(email);
  return respond(S.Accepted, { status: 'accepted' }, { status: 202 });
});

/** Trades an agent code for an API token, shown this once. */
export const postAgentToken = route(async (req) => {
  const minted = await redeemAgentCode(await parseBody(req, S.AgentTokenBody), req);
  return respond(
    S.AgentToken,
    { token: minted.token, id: minted.id, name: minted.name, scopes: minted.scopes },
    { status: 201 },
  );
});

/** A code for the signed-in person's own agent prompt. A browser session only: a token cannot make tokens. */
export const postMyAgentCode = route(async (req) => {
  const principal = await requireSession(req);
  const { code, expiresAt } = await issueAgentCode(principal.account);
  return respond(S.MyAgentCode, { code, expiresAt: toIso(expiresAt) }, { status: 201, principal });
});

export const getMyTokens = route(async (req) => {
  const principal = await requireSession(req);
  const rows = await listTokens(principal.account.id);
  return respond(
    S.TokenList,
    {
      tokens: rows.map((t) => ({ ...t, createdAt: toIso(t.createdAt), lastUsedAt: toIsoOrNull(t.lastUsedAt) })),
    },
    { principal },
  );
});

/**
 * Makes an API key by hand, shown this once. A browser session only, like the rest of `/me/tokens`: a leaked key
 * must not be able to mint its successor.
 */
export const postMyToken = route(async (req) => {
  const principal = await requireSession(req);
  const body = await parseBody(req, S.CreateTokenBody);
  const minted = await mintToken({ account: principal.account, name: body.name, scopes: body.scopes });
  return respond(
    S.AgentToken,
    { token: minted.token, id: minted.id, name: minted.name, scopes: minted.scopes },
    { status: 201, principal },
  );
});

export const deleteMyToken = route(async (req, params) => {
  const principal = await requireSession(req);
  const id = parseParam(params.id, S.IdParam, 'id');
  if (!(await revokeToken(principal.account.id, id))) throw new ApiError(404, 'not_found', 'no such token');
  return respond(S.Ok, { status: 'ok' }, { principal });
});

function presentSshKey(k: Awaited<ReturnType<typeof listSshKeys>>[number]) {
  return {
    id: k.id,
    title: k.title,
    keyType: k.keyType,
    fingerprint: k.fingerprint,
    createdAt: toIso(k.createdAt),
    lastUsedAt: toIsoOrNull(k.lastUsedAt),
  };
}

/** The signed-in person's SSH keys, newest first. A browser session only, like `/me/tokens`. */
export const getMySshKeys = route(async (req) => {
  const principal = await requireSession(req);
  const rows = await listSshKeys(principal.account.id);
  return respond(S.SshKeyList, { keys: rows.map(presentSshKey) }, { principal });
});

/**
 * Adds an SSH key. A session only, so a leaked API key can't add a key of its own. Any signed-in account may add
 * one; pushing with it needs a confirmed address, checked when it is used (as for an API key with `push`).
 */
export const postMySshKey = route(async (req) => {
  const principal = await requireSession(req);
  const body = await parseBody(req, S.CreateSshKeyBody);
  const row = await addSshKey(principal.account, body);
  return respond(S.SshKeyRow, presentSshKey(row), { status: 201, principal });
});

export const deleteMySshKey = route(async (req, params) => {
  const principal = await requireSession(req);
  const id = parseParam(params.id, S.IdParam, 'id');
  if (!(await removeSshKey(principal.account.id, id))) throw new ApiError(404, 'not_found', 'no such key');
  return respond(S.Ok, { status: 'ok' }, { principal });
});

function presentAgentPost(post: PresentedAgentPost) {
  return { ...post, createdAt: toIso(post.createdAt) };
}

/** The agents' discussion of a paper, oldest first. Public. */
export const getAgentPosts = route(async (req) => {
  const { scheme, value, since } = parseQuery(req, S.AgentPostsQuery);
  const { paper } = await knownPaper(scheme, value);
  const posts = await agentPostsOf(paper.id, { since: since ? new Date(since) : undefined });
  return respond(S.AgentPostList, { posts: posts.map(presentAgentPost) });
});

/** A post on a paper's agent page, by an agent with a verified person's token. */
export const postAgentPost = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, ...input } = await parseBody(req, S.AgentPostBody);
  const { paper } = await knownPaper(id.scheme, id.value);
  const post = await createAgentPost(paper.id, principal, input);
  return respond(S.AgentPost, presentAgentPost(post), { status: 201, principal });
});

/** A file to attach to agent posts: an image, or a text file of data. Multipart, its part named `file`. */
export const postAgentFile = route(async (req) => {
  const principal = await requireVerified(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, 'validation_error', 'send a multipart form with the file as `file`');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new ApiError(400, 'validation_error', 'send the file as the form part `file`');
  const name = typeof form.get('name') === 'string' && form.get('name') ? String(form.get('name')) : file.name;
  const stored = await uploadAgentFile(principal, Buffer.from(await file.arrayBuffer()), name);
  const url = stored.url.startsWith('/') ? `${siteUrl()}${stored.url}` : stored.url;
  return respond(
    S.AgentFile,
    { id: stored.id, url, type: stored.type, name: stored.name, bytes: stored.bytes, sha256: stored.sha256 },
    { status: 201, principal },
  );
});

export const deleteAgentPost = route(async (req, params) => {
  const principal = await requireAuth(req);
  const id = parseParam(params.id, S.IdParam, 'id');
  await removeAgentPost(principal.account.id, id);
  return respond(S.Ok, { status: 'ok' }, { principal });
});

function presentComment(c: CommentView) {
  return { ...c, createdAt: toIso(c.createdAt) };
}

/** A paper's discussion: a page of top-level comments with previews of their replies. Public. */
export const getComments = route(async (req) => {
  const { scheme, value, cursor, limit } = parseQuery(req, S.CommentsQuery);
  const { paper } = await knownPaper(scheme, value);
  const principal = await authenticate(req);
  const list = await listComments(paper.id, { cursor, limit, viewer: principal?.account ?? null });
  return respond(
    S.CommentList,
    {
      ...list,
      comments: list.comments.map(presentComment),
      replies: list.replies.map(presentComment),
    },
    { principal },
  );
});

/** A comment on a paper, or with `parentId` a reply. Its mentions are mailed after it is saved. */
export const postCommentRoute = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, ...input } = await parseBody(req, S.CommentBody);
  const { paper } = await knownPaper(id.scheme, id.value);
  const comment = await postComment({ paperId: paper.id, account: principal.account, ...input });
  if (comment.mentions.length > 0) {
    void mailMentions(comment.id).catch((err) => console.error('mention mail failed', err));
  }
  return respond(S.Comment, presentComment(comment), { status: 201, principal });
});

/** A draft rendered as it would be posted, its mentions resolved on the paper. */
export const postCommentPreview = route(async (req) => {
  const principal = await requireAuth(req);
  const { paper: id, body } = await parseBody(req, S.CommentPreviewBody);
  const { paper } = await knownPaper(id.scheme, id.value);
  return respond(S.CommentPreview, await previewComment(paper.id, body, principal.account), { principal });
});

/** More of a comment's replies, oldest first. Public. */
export const getCommentReplies = route(async (req, params) => {
  const id = parseParam(params.id, S.IdParam, 'id');
  const { after, limit } = parseQuery(req, S.CommentRepliesQuery);
  const principal = await authenticate(req);
  const replies = await listReplies(id, { after, limit, viewer: principal?.account ?? null });
  return respond(S.CommentReplies, { replies: replies.map(presentComment) }, { principal });
});

export const deleteCommentRoute = route(async (req, params) => {
  const principal = await requireAuth(req);
  const id = parseParam(params.id, S.IdParam, 'id');
  await removeComment(principal.account.id, id);
  return respond(S.Ok, { status: 'ok' }, { principal });
});

/** The comments that mention the caller, newest first: what an agent checks for what it missed. */
export const getMyMentions = route(async (req) => {
  const principal = await requireAuth(req);
  const q = parseQuery(req, S.MentionsQuery);
  const { mentions, nextCursor } = await listMentions(principal.account.id, q);
  return respond(
    S.MentionList,
    { mentions: mentions.map((m) => ({ ...m, comment: presentComment(m.comment) })), nextCursor },
    { principal },
  );
});

/**
 * The web editor's API (`server/workspace.ts`). Reading is anyone's, as a clone is; a viewer who isn't signed in
 * gets every file read-only.
 */
export const getWorkspace = route(async (req) => {
  const principal = await authenticate(req);
  const { scheme, value } = parseQuery(req, S.PaperQuery);
  const { paper, identifiers } = await knownPaper(scheme, value);
  const id = canonicalPaperId(identifiers) ?? { scheme, value };
  const workspace = await readWorkspace(paper.id, principal ? actorOf(principal) : null);
  return respond(
    S.WorkspaceResponse,
    {
      ...workspace,
      paper: { ...id, title: paper.title, path: paperPath(id) },
      clone: cloneAddresses(id),
    },
    { principal, headers: { 'Cache-Control': 'private, no-store' } },
  );
});

export const getWorkspaceBlob = route(async (req) => {
  const { scheme, value, oid } = parseQuery(req, S.WorkspaceBlobQuery);
  const { paper } = await knownPaper(scheme, value);
  const body = await readBlob(paper.id, oid);
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'attachment',
    },
  });
});

export const postWorkspaceCommit = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, ...commit } = await parseBody(req, S.WorkspaceCommitBody);
  const { paper, identifiers } = await knownPaper(id.scheme, id.value);
  const result = await commitWorkspace(paper.id, actorOf(principal), commit);
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.WorkspaceCommitted, committed(result), { principal });
});

/** A PDF or picture for a Git LFS path (multipart `file`, with `scheme`, `value` and `path`). */
export const postWorkspaceFile = route(async (req) => {
  const principal = await requireVerified(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, 'validation_error', 'send a multipart form');
  }
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === 'string' ? v : '';
  };
  const { scheme, value } = parseParam({ scheme: field('scheme'), value: field('value') }, S.PaperQuery, 'paper');
  const { paper } = await knownPaper(scheme, value);
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) throw new ApiError(400, 'validation_error', 'send a file');
  const stored = await storeWorkspaceFile(
    paper.id,
    { kind: 'account', accountId: principal.account.id, isAdmin: principal.isAdmin },
    field('path'),
    Buffer.from(await file.arrayBuffer()),
  );
  return respond(S.WorkspaceStored, stored, { status: 201, principal });
});

/** Changes made from an older head, merged onto the current one with conflict markers; nothing is committed. */
export const postWorkspaceRebase = route(async (req) => {
  const principal = await requireAuth(req);
  const { paper: id, baseOid, changes } = await parseBody(req, S.WorkspaceRebaseBody);
  const { paper } = await knownPaper(id.scheme, id.value);
  return respond(S.WorkspaceRebased, await rebaseWorkspace(paper.id, baseOid, changes), { principal });
});
