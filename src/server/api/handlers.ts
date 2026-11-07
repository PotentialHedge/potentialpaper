import { headers as nextHeaders } from 'next/headers';
import type { Account, Affiliation } from '@/db/schema';
import { updateProfile } from '../accounts';
import { addAffiliation, listAffiliations, removeAffiliation, verifyAffiliation } from '../affiliations';
import { requireAuth, viewerFromHeaders } from '../auth';
import { setFirstPassword, startOnboarding } from '../onboarding';
import { canonicalPaperId, paperPath, parsePaperId } from '@/lib/paper-ids';
import { lookupPaper } from '../papers';
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
