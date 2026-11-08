import { headers as nextHeaders } from 'next/headers';
import type { z } from 'zod';
import type { Account, Affiliation } from '@/db/schema';
import { updateProfile } from '../accounts';
import { addAffiliation, listAffiliations, removeAffiliation, verifyAffiliation } from '../affiliations';
import { requireAuth, requireVerified, viewerFromHeaders, type Principal } from '../auth';
import { demoSources } from '../demos/attach';
import { snapshotDemo } from '../demos/snapshot';
import { demoUrl } from '@/lib/demos';
import { claimRoles, ownClaim, requestClaim, withdrawClaim } from '../claims';
import { removeThumbnail, setLinks, setThumbnail } from '../pages/card';
import { revertCommit, type Actor, type CommitResult } from '../pages/commit';
import { editorState, editSection } from '../pages/edit';
import { demoIds, renderMarkdown } from '../pages/markdown';
import { getDb } from '@/db';
import { pageCurrent } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { refreshPaperPages } from '../pages/refresh';
import { setFirstPassword, startOnboarding } from '../onboarding';
import { canonicalPaperId, paperPath, parsePaperId } from '@/lib/paper-ids';
import { findPaper, lookupPaper } from '../papers';
import { searchPapers } from '../search';
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

/**
 * What the editor on a paper's page opens with, and whether this viewer may save it: the same rules the
 * commit enforces (`pages/rules.ts`), asked up front so that the page can say so before anything is typed.
 */
export const getEditor = route(async (req) => {
  const principal = await requireAuth(req);
  const { scheme, value, part, section } = parseQuery(req, S.EditorQuery);
  const { paper } = await knownPaper(scheme, value);
  const verified = principal.account.isBot || principal.account.verifiedAt !== null;
  const roles = await claimRoles(paper.id, principal.account.id);
  const may = principal.isAdmin || roles.confirmedAuthor;
  if (!verified && !principal.isAdmin) {
    throw new ApiError(403, 'not_verified', 'editing needs a confirmed institutional email address');
  }
  if (part === 'author' && !may) {
    throw new ApiError(403, 'forbidden', "only this paper's confirmed authors can write its author section");
  }
  if (part === 'card') {
    if (roles.claimed && !may) {
      throw new ApiError(403, 'forbidden', 'this paper is claimed, so its authors choose its picture and links');
    }
    const [current] = await getDb()
      .select({ thumbnail: pageCurrent.thumbnail, links: pageCurrent.links })
      .from(pageCurrent)
      .where(eq(pageCurrent.paperId, paper.id));
    const thumbnail = current?.thumbnail ?? null;
    return respond(
      S.EditorOpened,
      {
        part,
        thumbnail: thumbnail && { url: thumbnail.url, alt: thumbnail.alt ?? null, caption: thumbnail.caption ?? null },
        links: current?.links ?? [],
        claimed: roles.claimed,
      },
      { principal },
    );
  }
  const state = await editorState(paper.id, part, section);
  if (!state) throw new ApiError(404, 'not_found', `the page has no section ${section} any more`);
  return respond(S.EditorOpened, state, { principal });
});

/** One section of the author or community page, put back into the file as it was when the editor loaded it. */
export const postSectionEdit = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, ...edit } = await parseBody(req, S.SectionEditBody);
  const { paper, identifiers } = await knownPaper(id.scheme, id.value);
  const result = await editSection(paper.id, actorOf(principal), edit);
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.PageCommitted, committed(result), { principal });
});

/** The editor's preview, through the renderer commits use. Signed-in only, as only editors need it. */
export const postRender = route(async (req) => {
  const principal = await requireAuth(req);
  const { content } = await parseBody(req, S.RenderBody);
  const demos = await demoSources(getDb(), demoIds(content));
  return respond(S.Rendered, { html: renderMarkdown(content, 'preview', demos) }, { principal });
});

/** Undoes one commit, keeping everything since, as `git revert` does. */
export const postRevert = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, oid, summary } = await parseBody(req, S.RevertBody);
  const { paper, identifiers } = await knownPaper(id.scheme, id.value);
  const result = await revertCommit(paper.id, oid, actorOf(principal), summary?.trim() || undefined);
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.PageCommitted, committed(result), { principal });
});

/** The page's own links under its title, replaced as a whole. */
export const postLinks = route(async (req) => {
  const principal = await requireVerified(req);
  const { paper: id, links } = await parseBody(req, S.LinksBody);
  const { paper, identifiers } = await knownPaper(id.scheme, id.value);
  const result = await setLinks(paper.id, actorOf(principal), links);
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.PageCommitted, committed(result), { principal });
});

/** A new picture (multipart `image`), or new words for the current one. */
export const postThumbnail = route(async (req) => {
  const principal = await requireVerified(req);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, 'validation_error', 'send a multipart form');
  }
  const fields = S.ThumbnailFields.safeParse(
    Object.fromEntries([...form.entries()].filter(([, v]) => typeof v === 'string')),
  );
  if (!fields.success) throw new ApiError(400, 'validation_error', 'invalid form');
  const { paper, identifiers } = await knownPaper(fields.data.scheme, fields.data.value);
  const file = form.get('image');
  const image = file instanceof File && file.size > 0 ? Buffer.from(await file.arrayBuffer()) : undefined;
  const result = await setThumbnail(paper.id, actorOf(principal), {
    image,
    alt: fields.data.alt,
    caption: fields.data.caption,
  });
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.PageCommitted, committed(result), { principal });
});

export const deleteThumbnail = route(async (req) => {
  const principal = await requireVerified(req);
  const { scheme, value } = parseQuery(req, S.PaperQuery);
  const { paper, identifiers } = await knownPaper(scheme, value);
  const result = await removeThumbnail(paper.id, actorOf(principal));
  if (result.status === 'committed') await refreshPaperPages(identifiers);
  return respond(S.PageCommitted, committed(result), { principal });
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
