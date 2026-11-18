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
import { formatIdentifier, keyedPagePath } from '@/lib/kinds';
import { addCoAuthor, ownClaim, requestClaim, withdrawClaim } from '../claims';
import { authoredPapers } from '../my-papers';
import {
  followedPapers,
  followPaper,
  followState,
  mailAddedCoAuthor,
  mailCommentFollowers,
  mailEditFollowers,
  unfollowPaper,
} from '../follows';
import { revertCommit, type Actor, type CommitResult } from '../pages/commit';
import { renderHtml } from '../pages/html';
import { renderMarkdown } from '../pages/markdown';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { refreshPageIds, refreshPaperPages } from '../pages/refresh';
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
import { saveUserSettings, settingsFor, siteSettingsView, type SettingsView, venueStatsHideUntil } from '../settings';
import { MAX_SETTINGS_BYTES } from '@/lib/settings';
import { grantPlugin, installedPlugins, installPlugin, revokePlugin, uninstallPlugin } from '../plugins/installed';
import {
  mustFindPage,
  mustFindScope,
  pageSummaries,
  pageMembersForPlugins,
  paperSubmissionsForPlugins,
  readPageForPlugins,
  resolvePage,
} from '../plugins/pages';
import { pluginStorage, setPluginStorage, storageBytes } from '../plugins/storage';
import { identityTokenFor } from '../plugins/identity';
import { DISCOVER_CACHE_MS, discoverPlugins } from '../plugins/discover';
import { pluginUpdates, updatePlugin } from '../plugins/updates';
import { findPage } from '../pages/kinds';
import { isClaimable, ownPageClaim, requestPageClaim, withdrawPageClaim } from '../page-claims';
import { presentVenuePapers } from '../venue-pages';
import { createOrgChild, orgOverview, presentOrgOverview } from '../org-pages';
import { scopeChangedAt, scopePaperChunk, scopeScoreField, scopeScoreList, scopeScoreMarks } from '../scope-stats';
import { rolesOf } from '../pages/check';
import { presentChanges, recentChanges } from '../changes';
import { protectionOf, setProtection } from '../page-protection';
import { presentTopicPapers } from '../topic-papers';
import {
  createTopic,
  decideSuggestion,
  editTopic,
  linkPaperToTopic,
  mergeTopic,
  presentTopicOverview,
  renameTopic,
  similarTopics,
  topicOverview,
  topicSuggestionList,
} from '../topic-pages';
import { countTransition, countView, transitionCounts } from '../view-counter';
import { ApiError } from './errors';
import {
  clientIp,
  etagOf,
  notModified,
  parseBody,
  parseParam,
  parseQuery,
  respond,
  respondCached,
  route,
  toIso,
  toIsoOrNull,
} from './http';
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
    followMail: a.followMail,
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

function presentSettings(view: SettingsView) {
  return { ...view, updatedAt: toIsoOrNull(view.updatedAt) };
}

/** The account's settings.json (DESIGN.md §10), as written, with every setting's resolved value. */
export const getMySettings = route(async (req) => {
  const principal = await requireAuth(req);
  return respond(S.MySettings, presentSettings(await settingsFor(principal.account)), { principal });
});

/**
 * Replace the account's settings.json. The body is the file itself (JSONC), whatever its content type. A 422 lists
 * every error, one per line, each naming its key; unknown keys are kept, with a warning in `problems`.
 */
export const putMySettings = route(async (req) => {
  const principal = await requireAuth(req);
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_SETTINGS_BYTES * 2) {
    throw new ApiError(413, 'validation_error', `settings.json may be at most ${MAX_SETTINGS_BYTES / 1024} KB`);
  }
  const text = await req.text();
  return respond(S.MySettings, presentSettings(await saveUserSettings(principal.account, text)), { principal });
});

/** The site layer of settings and the values it gives, for readers who aren't signed in. Public. */
export const getSiteSettings = route(async () => {
  return respond(S.SiteSettings, await siteSettingsView());
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

/** Mails the paper's followers about a commit, after it, never holding up or failing the request. */
function notifyEdit(paperId: string, principal: Principal, result: CommitResult): void {
  if (result.status !== 'committed') return;
  void mailEditFollowers(paperId, principal.account.id, [result.seq]).catch((err) =>
    console.error('follow mail failed', err),
  );
}

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
  notifyEdit(paper.id, principal, result);
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
  notifyEdit(paper.id, principal, result);
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
    getDb().select({ pdf: pageCurrent.pdf }).from(pageCurrent).where(eq(pageCurrent.pageId, paper.id)),
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

/** The papers the viewer is an author of, or has claimed (`/papers`). */
export const getMyPapers = route(async (req) => {
  const principal = await requireAuth(req);
  const [authored, following] = await Promise.all([
    authoredPapers(principal.account.id),
    followedPapers(principal.account.id),
  ]);
  return respond(
    S.MyPapers,
    {
      following: following.map(({ canonical, followedAt, ...row }) => ({
        ...row,
        paper: canonical,
        followedAt: toIso(followedAt),
      })),
      // The schema drops the internal `paperId`.
      authored: authored.map(({ canonical, waiting, ...row }) => ({
        ...row,
        paper: canonical,
        waiting: waiting.map(({ claimId, createdAt, ...w }) => ({ ...w, claim: claimId, createdAt: toIso(createdAt) })),
      })),
    },
    { principal },
  );
});

/** A confirmed author adds a co-author, confirmed at once (`method: 'vouch'`). */
export const postCoAuthor = route(async (req) => {
  const principal = await requireVerified(req);
  const body = await parseBody(req, S.CoAuthorBody);
  const { paper } = await knownPaper(body.paper.scheme, body.paper.value);
  const { accountId, ...added } = await addCoAuthor(
    paper.id,
    principal.account,
    'claim' in body ? { claimId: body.claim } : { handle: body.handle, authorIndex: body.authorIndex },
  );
  void mailAddedCoAuthor(paper.id, { accountId, authorName: added.authorName }, principal.account.handle).catch((err) =>
    console.error('co-author mail failed', err),
  );
  return respond(S.CoAuthorAdded, added, { status: 201, principal });
});

/** Whether the viewer follows the paper, and how many do. Public; `following` is `null` for nobody signed in. */
export const getFollow = route(async (req) => {
  const { scheme, value } = parseQuery(req, S.PaperQuery);
  const { paper } = await knownPaper(scheme, value);
  const principal = await authenticate(req);
  return respond(S.FollowState, await followState(paper.id, principal?.account.id ?? null), {
    principal,
    headers: { 'Cache-Control': 'private, no-store' },
  });
});

/** Follows (stars) the paper: its edits and comments are mailed (`server/follows.ts`). */
export const postFollow = route(async (req) => {
  const principal = await requireAuth(req);
  const { paper: id } = await parseBody(req, S.FollowBody);
  const { paper } = await knownPaper(id.scheme, id.value);
  await followPaper(paper.id, principal.account.id);
  return respond(S.FollowState, await followState(paper.id, principal.account.id), { principal });
});

export const deleteFollow = route(async (req) => {
  const principal = await requireAuth(req);
  const { scheme, value } = parseQuery(req, S.PaperQuery);
  const { paper } = await knownPaper(scheme, value);
  await unfollowPaper(paper.id, principal.account.id);
  return respond(S.FollowState, await followState(paper.id, principal.account.id), { principal });
});

/**
 * Counts the caller as a viewer of the page today (`server/view-counter.ts`): every page's beacon. Sent with the
 * session cookie, so a signed-in reader counts as their account, anyone else as their network. `from`, the page this
 * tab read just before, is counted as a transition; a stale or mangled one never costs the view.
 */
export const postView = route(async (req) => {
  const principal = await authenticate(req);
  const { page, from } = await parseBody(req, S.ViewBody);
  const viewer = { accountId: principal?.account.id, ip: clientIp(req) };
  const views = await countView(page, viewer);
  if (views === null) throw new ApiError(404, 'not_found', 'no page with that id');
  const fromId = S.IdParam.safeParse(from);
  if (fromId.success) await countTransition(fromId.data, page, viewer);
  return respond(S.ViewState, { views }, { principal });
});

/** Totals of visitors who read one page and then another, for related papers. Admins only. */
export const getTransitions = route(async (req) => {
  const principal = await requireAuth(req);
  if (!principal.isAdmin) throw new ApiError(403, 'forbidden', 'only admins read transitions');
  const { min } = parseQuery(req, S.TransitionsQuery);
  return respond(S.Transitions, { transitions: await transitionCounts(min) }, { principal });
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
  void mailCommentFollowers(comment.id).catch((err) => console.error('follow mail failed', err));
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
  notifyEdit(paper.id, principal, result);
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

// Plugins (`handoffs/plugins.md` Phase 2, `server/plugins/`).

/**
 * The reader's plugins, as a page runs them: each with its copy, its manifest and whether it may run. Copies a plugin
 * not copied yet. Signed out, the site's `plugins.default`. With `?page=<identifier>`, also whether the reader owns
 * that page, for `when` conditions (`viewer.isOwner`).
 */
export const getInstalledPlugins = route(async (req) => {
  const { page } = parseQuery(req, S.InstalledQuery);
  const principal = await authenticate(req).catch(() => null);
  const account = principal?.account ?? null;
  const plugins = await installedPlugins(account);
  let isOwner = false;
  if (principal && page) {
    const found = await findPage(page);
    if (found) isOwner = (await rolesOf(getDb(), actorOf(principal), found.id)).owner;
  }
  return respond(
    S.InstalledPlugins,
    {
      plugins: plugins.map((p) => ({
        ...p,
        plugin: p.plugin && { ...p.plugin, manifest: p.plugin.manifest as unknown as Record<string, unknown> },
      })),
      viewer: { signedIn: account !== null, isOwner },
    },
    { principal },
  );
});

/** Install a plugin from a source: it is copied and added to settings.json's `plugins`. It runs once approved. */
export const postMyPlugin = route(async (req) => {
  const principal = await requireAuth(req);
  const { source } = await parseBody(req, S.PluginInstallBody);
  const installed = await installPlugin(principal.account, source);
  return respond(
    S.InstalledPlugin,
    { ...installed, plugin: installed.plugin && { ...installed.plugin, manifest: installed.plugin.manifest as never } },
    { principal, status: 201 },
  );
});

/** Remove a plugin from settings.json (a site default is turned off instead). */
export const deleteMyPlugin = route(async (req) => {
  const principal = await requireAuth(req);
  const { source } = parseQuery(req, S.PluginSourceQuery);
  await uninstallPlugin(principal.account, source);
  return respond(S.Ok, { status: 'ok' }, { principal });
});

/**
 * Approve a plugin at the commit it runs, with what its manifest asks for. Only in a browser, by the reader: consent
 * is never given by an agent's token.
 */
export const putPluginGrant = route(async (req) => {
  const principal = await requireSession(req);
  const { plugin, commit } = await parseBody(req, S.PluginGrantBody);
  await grantPlugin(principal.account, plugin, commit);
  return respond(S.Ok, { status: 'ok' }, { principal });
});

export const deletePluginGrant = route(async (req) => {
  const principal = await requireAuth(req);
  const { plugin } = parseQuery(req, S.PluginIdQuery);
  await revokePlugin(principal.account, plugin);
  return respond(S.Ok, { status: 'ok' }, { principal });
});

/**
 * A short-lived token naming the reader to one of their plugins' backends (`pp.identity.token()`, permission
 * `identity`). Only in a browser: the frame's host asks for it on the plugin's behalf. Never cached.
 */
export const postPluginIdentity = route(async (req) => {
  const principal = await requireSession(req);
  const body = await parseBody(req, S.PluginIdentityBody);
  const token = await identityTokenFor(principal.account, body);
  return respond(S.PluginIdentityToken, token, { principal, headers: { 'Cache-Control': 'no-store' } });
});

/**
 * Plugins people can find: public GitHub repos with the topic `potentialpaper-plugin`, most starred first. Public,
 * cached five minutes; while GitHub fails, the last list is served (`stale`).
 */
export const getDiscoveredPlugins = route(async () => {
  let directory;
  try {
    directory = await discoverPlugins();
  } catch (err) {
    throw new ApiError(502, 'source_unavailable', (err as Error).message);
  }
  return respond(S.DiscoveredPlugins, directory, {
    headers: { 'Cache-Control': `public, max-age=${DISCOVER_CACHE_MS / 1000}` },
  });
});

/** The reader's installed plugins with a newer release than the version they run. */
export const getPluginUpdates = route(async (req) => {
  const principal = await requireAuth(req);
  const { plugin } = parseQuery(req, S.PluginUpdatesQuery);
  return respond(
    S.PluginUpdates,
    { updates: await pluginUpdates(principal.account, undefined, plugin) },
    { principal },
  );
});

/**
 * Move a plugin to its newest release (or `ref`). An update that asks for new permissions or network origins
 * switches only with `approve`, which only a browser session may send; otherwise it comes back as `consent`, saying
 * what the new version asks for, and nothing changes.
 */
export const postPluginUpdate = route(async (req) => {
  const body = await parseBody(req, S.PluginUpdateBody);
  const principal = body.approve ? await requireSession(req) : await requireAuth(req);
  const result = await updatePlugin(principal.account, body);
  return respond(
    S.PluginUpdateResult,
    result.status === 'updated'
      ? {
          ...result,
          plugin: {
            ...result.plugin,
            plugin: result.plugin.plugin && {
              ...result.plugin.plugin,
              manifest: result.plugin.plugin.manifest as never,
            },
          },
        }
      : result,
    { principal },
  );
});

/** A plugin's storage for the account (`storage.get`). */
export const getPluginStorage = route(async (req) => {
  const principal = await requireAuth(req);
  const { plugin } = parseQuery(req, S.PluginIdQuery);
  const data = await pluginStorage(principal.account, plugin);
  return respond(S.PluginStorage, { data, bytes: storageBytes(data) }, { principal });
});

/** Set one key of a plugin's storage (`storage.set`); `null` removes it. At most 64 KB per plugin. */
export const putPluginStorage = route(async (req) => {
  const principal = await requireAuth(req);
  const { plugin, key, value } = await parseBody(req, S.PluginStorageBody);
  const data = await setPluginStorage(principal.account, plugin, key, value);
  return respond(S.PluginStorage, { data, bytes: storageBytes(data) }, { principal });
});

/** The identifier in a `/pages/{identifier}` path: one segment, URL-encoded (`venue%3Aiclr%2F2027`). */
function identifierParam(params: Record<string, string | string[]>): string {
  const raw = params.identifier;
  const text = Array.isArray(raw) ? raw.join('/') : raw;
  try {
    return decodeURIComponent(text ?? '');
  } catch {
    throw new ApiError(400, 'validation_error', 'invalid path parameter "identifier"');
  }
}

/** Public, and cached a minute: what anyone reading the page sees. */
const PUBLIC_MINUTE = { 'Cache-Control': 'public, max-age=60' };

/** A page of any kind by its identifier (`page.resolve`): its summary, its scopes and its facts. Public. */
export const getPageSummary = route(async (_req, params) => {
  return respond(S.PageResponse, await resolvePage(identifierParam(params)), { headers: PUBLIC_MINUTE });
});

/** A page's kind file, sections and links (`page.read`). Public. */
export const getPageFiles = route(async (_req, params) => {
  return respond(S.PageFiles, await readPageForPlugins(identifierParam(params)), { headers: PUBLIC_MINUTE });
});

/** A scope's papers, rolled up from the pages under it (`page.members`). Public. */
export const getPageMembers = route(async (req, params) => {
  const { offset, limit, rollUp } = parseQuery(req, S.PageMembersQuery);
  return respond(
    S.PageMembers,
    await pageMembersForPlugins(identifierParam(params), { offset, limit, rollUp: rollUp === 'true' }),
    { headers: PUBLIC_MINUTE },
  );
});

/** A paper's submissions, their notes and their venues' forms (`reviews.forPaper`). Public: the reviews are CC BY. */
export const getPageSubmissions = route(async (_req, params) => {
  return respond(S.PageSubmissions, await paperSubmissionsForPlugins(identifierParam(params)), {
    headers: PUBLIC_MINUTE,
  });
});

/** The keyed page an identifier names, for the routes about owning one: a venue's organisers. */
async function claimablePage(params: Record<string, string | string[]>) {
  const page = await mustFindPage(identifierParam(params));
  if (!isClaimable(page.kind)) throw new ApiError(422, 'validation_error', 'only a venue can be claimed');
  return page;
}

/** The viewer's claim to organise a venue. */
export const getPageClaim = route(async (req, params) => {
  const principal = await requireAuth(req);
  const page = await claimablePage(params);
  return respond(S.OwnPageClaim, { claim: await ownPageClaim(page, principal.account.id) }, { principal });
});

/** Asks to be confirmed as one of a venue's organisers. An admin decides. */
export const postPageClaim = route(async (req, params) => {
  const principal = await requireVerified(req);
  const page = await claimablePage(params);
  const { evidence } = await parseBody(req, S.PageClaimBody);
  const claim = await requestPageClaim(page, principal.account, { evidence });
  return respond(S.OwnPageClaim, { claim }, { status: 201, principal });
});

/** Takes back a claim to organise a venue, or steps down as its organiser. */
export const deletePageClaim = route(async (req, params) => {
  const principal = await requireAuth(req);
  const page = await claimablePage(params);
  await withdrawPageClaim(page, principal.account.id);
  return respond(S.OwnPageClaim, { claim: null }, { principal });
});

async function orgPage(params: Record<string, string | string[]>) {
  const page = await mustFindPage(identifierParam(params));
  if (page.kind !== 'org') throw new ApiError(422, 'validation_error', 'only an organisation page has this');
  return page;
}

/** An org's parent, departments and labs, the members who show their institution, and its venues and topics by count. Public. */
export const getOrgOverview = route(async (_req, params) => {
  const page = await orgPage(params);
  return respond(S.OrgOverview, presentOrgOverview(await orgOverview(page), siteUrl()), { headers: PUBLIC_MINUTE });
});

/** Makes a department or lab under an org. Its verified members and admins may. */
export const postOrgChild = route(async (req, params) => {
  const principal = await requireVerified(req);
  const parent = await orgPage(params);
  const body = await parseBody(req, S.OrgChildBody);
  const page = await createOrgChild(parent, body, actorOf(principal));
  return respond(S.PageResponse, await resolvePage(formatIdentifier({ kind: 'org', key: page.key })), {
    status: 201,
    principal,
  });
});

/** A venue's submissions by status, decision and title, rolled up from its editions. Public. */
export const getVenuePapers = route(async (req, params) => {
  const page = await mustFindPage(identifierParam(params));
  if (page.kind !== 'venue') throw new ApiError(422, 'validation_error', 'only a venue page lists submissions');
  const filter = parseQuery(req, S.VenuePapersQuery);
  return respond(S.VenuePapers, await presentVenuePapers(page.id, filter), { headers: PUBLIC_MINUTE });
});

/** A path parameter that is one URL-encoded segment: a venue id (`openreview%3AICLR.cc%2F2027%2FConference`). */
function encodedParam(params: Record<string, string | string[]>, name: string): string {
  const raw = params[name];
  const text = Array.isArray(raw) ? raw.join('/') : raw;
  try {
    return decodeURIComponent(text ?? '');
  } catch {
    throw new ApiError(400, 'validation_error', `invalid path parameter "${name}"`);
  }
}

async function scopeSummary(pageId: string) {
  const summary = (await pageSummaries([pageId])).get(pageId);
  if (!summary) throw new ApiError(404, 'not_found', 'no such page');
  return summary;
}

/** A scope's venues and score fields with their counts (data for plugins A, `scope.scores`). Public, ETagged. */
export const getPageScores = route(async (req, params) => {
  const page = await mustFindScope(identifierParam(params));
  const hideUntil = await venueStatsHideUntil();
  const [summary, scores] = await Promise.all([scopeSummary(page.id), scopeScoreList(page.id, hideUntil)]);
  return respondCached(req, S.PageScores, { page: summary, hideUntil, scores }, PUBLIC_MINUTE);
});

/** One field's statistics at one venue of a scope: sorted means, bins, the split by outcome. Public, ETagged. */
export const getPageScoreField = route(async (req, params) => {
  const page = await mustFindScope(identifierParam(params));
  const venue = encodedParam(params, 'venue');
  const field = encodedParam(params, 'field');
  const query = parseQuery(req, S.PageScoreFieldQuery);
  const [summary, detail] = await Promise.all([
    scopeSummary(page.id),
    scopeScoreField(page.id, venue, field, await venueStatsHideUntil()),
  ]);
  if (!detail) throw new ApiError(404, 'not_found', `no statistics of "${field}" at ${venue} here`);
  const marks =
    query.marks !== 'true'
      ? undefined
      : detail.hidden
        ? []
        : await scopeScoreMarks(page.id, venue, field, detail.count);
  return respondCached(
    req,
    S.PageScoreField,
    { ...detail, page: summary, ...(marks === undefined ? {} : { marks }) },
    PUBLIC_MINUTE,
  );
});

/** Chunks a stream reads at a time. */
const PAPERS_CHUNK = 500;

/**
 * A scope's papers in bulk (data for plugins B, `scope.papers`), as NDJSON: one paper a line with its submissions,
 * their statuses and every review's score vector. Public: the reviews are CC BY, and each carries its licence and
 * source link. ETagged on the scope's last change, gzipped when the client takes it. With `limit`, one chunk, and the
 * cursor for the next in `X-Next-Cursor`.
 */
export const getPagePapers = route(async (req, params) => {
  const page = await mustFindScope(identifierParam(params));
  const query = parseQuery(req, S.PagePapersQuery);
  const fields = [...query.fields];
  const changedAt = await scopeChangedAt(page.id);
  const etag = etagOf(
    JSON.stringify([page.id, changedAt?.toISOString() ?? null, fields, query.after ?? null, query.limit ?? null]),
  );
  const headers: Record<string, string> = {
    ...PUBLIC_MINUTE,
    ETag: etag,
    Vary: 'Accept-Encoding',
    Link: '<https://creativecommons.org/licenses/by/4.0/>; rel="license"',
  };
  if (notModified(req, etag)) return new Response(null, { status: 304, headers });

  const encoder = new TextEncoder();
  const lines = (rows: unknown[]) => encoder.encode(rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  let body: ReadableStream<Uint8Array>;
  if (query.limit !== undefined) {
    const chunk = await scopePaperChunk(page.id, { after: query.after, limit: query.limit, fields });
    if (chunk.next) headers['X-Next-Cursor'] = chunk.next;
    const bytes = lines(chunk.rows);
    body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  } else {
    let after: string | null = query.after ?? null;
    body = new ReadableStream({
      async pull(controller) {
        try {
          const chunk = await scopePaperChunk(page.id, { after, limit: PAPERS_CHUNK, fields });
          if (chunk.rows.length > 0) controller.enqueue(lines(chunk.rows));
          after = chunk.next;
          if (!after) controller.close();
        } catch (err) {
          console.error(err);
          controller.error(err);
        }
      },
    });
  }
  const gzip = /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '');
  if (gzip) {
    body = body.pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
    headers['Content-Encoding'] = 'gzip';
  }
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'application/x-ndjson' } });
});

// Topic pages (`handoffs/pages.md` Phase 5, `server/topic-pages.ts`), page protection and the patrol feed.

async function topicPage(params: Record<string, string | string[]>) {
  const page = await mustFindPage(identifierParam(params));
  if (page.kind !== 'topic') throw new ApiError(422, 'validation_error', 'only a topic page has this');
  return page;
}

/** Topics whose name or an alias is like `q`, the same name first: what the forms check before making one. Public. */
export const getTopics = route(async (req) => {
  const { q } = parseQuery(req, S.TopicSearchQuery);
  const origin = siteUrl();
  const topics = (await similarTopics(q)).map((t) => ({ ...t, url: `${origin}${keyedPagePath('topic', t.key)}` }));
  return respond(S.TopicMatches, { topics }, { headers: PUBLIC_MINUTE });
});

/** Makes a topic. Anyone verified may; a name or alias another topic has is refused (`topic_exists`). */
export const postTopic = route(async (req) => {
  const principal = await requireVerified(req);
  const body = await parseBody(req, S.NewTopicBody);
  const page = await createTopic(body, actorOf(principal));
  return respond(S.PageResponse, await resolvePage(formatIdentifier({ kind: 'topic', key: page.key })), {
    status: 201,
    principal,
  });
});

/** Puts a paper in a topic (a labeled link from the paper), making the topic if it is named and doesn't exist. */
export const postPaperTopic = route(async (req, params) => {
  const principal = await requireVerified(req);
  const paper = await mustFindPage(identifierParam(params));
  const body = await parseBody(req, S.PaperTopicBody);
  const result = await linkPaperToTopic(paper, body, actorOf(principal));
  const summary = (await pageSummaries([result.topic.id])).get(result.topic.id)!;
  return respond(
    S.PaperTopicResult,
    { topic: summary, created: result.created, status: result.status },
    { status: result.status === 'linked' ? 201 : 200, principal },
  );
});

/** A topic's broader, narrower and related topics, the papers that introduced it, its venues and orgs. Public. */
export const getTopicOverview = route(async (_req, params) => {
  const page = await topicPage(params);
  return respond(S.TopicOverview, presentTopicOverview(await topicOverview(page), siteUrl()), {
    headers: PUBLIC_MINUTE,
  });
});

/** Edits a topic: its name, aliases, broader topics, article and related topics, in one commit. */
export const patchTopic = route(async (req, params) => {
  const principal = await requireVerified(req);
  const page = await topicPage(params);
  const body = await parseBody(req, S.TopicEditBody);
  const result = await editTopic(page, body, actorOf(principal));
  return respond(S.TopicEdited, { head: result.oid, changed: result.status === 'committed' }, { principal });
});

/** A topic's papers, rolled up from its narrower topics, sorted by date, venue or score. Public. */
export const getTopicPapers = route(async (req, params) => {
  const page = await topicPage(params);
  const query = parseQuery(req, S.TopicPapersQuery);
  return respond(S.TopicPapers, await presentTopicPapers(page.id, query), { headers: PUBLIC_MINUTE });
});

/** Gives a topic a new address (and name), leaving a redirect from the old. */
export const postRename = route(async (req, params) => {
  const principal = await requireVerified(req);
  const page = await topicPage(params);
  const body = await parseBody(req, S.RenameBody);
  const moved = await renameTopic(page, body, actorOf(principal));
  return respond(S.PageResponse, await resolvePage(formatIdentifier({ kind: 'topic', key: moved.key })), {
    principal,
  });
});

/** Merges this topic into another, leaving a redirect. */
export const postMerge = route(async (req, params) => {
  const principal = await requireVerified(req);
  const page = await topicPage(params);
  const { into, summary } = await parseBody(req, S.MergeBody);
  const survivor = await mustFindPage(into.includes(':') ? into : `topic:${into}`);
  await mergeTopic(page, survivor, actorOf(principal), { summary });
  return respond(S.PageResponse, await resolvePage(formatIdentifier({ kind: 'topic', key: survivor.key })), {
    principal,
  });
});

/** Papers that might belong in a topic, best first. Public. */
export const getSuggestions = route(async (req, params) => {
  const page = await topicPage(params);
  const { offset, limit } = parseQuery(req, S.SuggestionsQuery);
  return respond(S.Suggestions, await topicSuggestionList(page.id, { offset, limit }), { headers: PUBLIC_MINUTE });
});

/** Confirms (links the paper) or dismisses (remembered, so it doesn't come back) a suggestion. */
export const postSuggestion = route(async (req, params) => {
  const principal = await requireVerified(req);
  const page = await topicPage(params);
  const { paper, action, label } = await parseBody(req, S.SuggestionBody);
  await decideSuggestion(page, await mustFindPage(paper), { action, label }, actorOf(principal));
  return respond(S.Suggestions, await topicSuggestionList(page.id, {}), { principal });
});

function presentProtection(protection: Awaited<ReturnType<typeof protectionOf>>) {
  return {
    protection: protection
      ? { level: protection.level, reason: protection.reason, expiresAt: toIsoOrNull(protection.expiresAt) }
      : null,
  };
}

/** A page's protection, if it has one. Public. */
export const getProtection = route(async (_req, params) => {
  const page = await mustFindPage(identifierParam(params));
  return respond(S.Protection, presentProtection(await protectionOf(getDb(), page.id)), { headers: PUBLIC_MINUTE });
});

/** Sets or lifts a page's protection. Admins only. */
export const putProtection = route(async (req, params) => {
  const principal = await requireAuth(req);
  if (!principal.isAdmin) throw new ApiError(403, 'forbidden', 'only admins protect pages');
  const page = await mustFindPage(identifierParam(params));
  const { level, reason, expiresAt } = await parseBody(req, S.ProtectionBody);
  const protection = await setProtection(
    page,
    { level, reason, expiresAt: expiresAt ? new Date(expiresAt) : null },
    actorOf(principal),
  );
  await refreshPageIds(getDb(), [page.id]);
  return respond(S.Protection, presentProtection(protection), { principal });
});

/** The patrol feed: every commit to every page, newest first, bots hidden unless asked. Public. */
export const getChanges = route(async (req) => {
  const query = parseQuery(req, S.ChangesQuery);
  const changes = await recentChanges({
    kind: query.kind,
    bots: query.bots === 'true',
    rollUp: query.rollUp === 'true',
    before: query.before,
    limit: query.limit,
  });
  return respond(S.Changes, presentChanges(changes, query.limit), { headers: PUBLIC_MINUTE });
});
