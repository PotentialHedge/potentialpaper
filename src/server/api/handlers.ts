import { headers as nextHeaders } from 'next/headers';
import type { Account, Affiliation } from '@/db/schema';
import { updateProfile } from '../accounts';
import { addAffiliation, listAffiliations, removeAffiliation, verifyAffiliation } from '../affiliations';
import { requireAdmin, requireAuth, viewerFromHeaders } from '../auth';
import { approveDomain, rejectDomain, requestInstitution } from '../institution-requests';
import { setFirstPassword, startOnboarding } from '../onboarding';
import { clientIp, parseBody, parseParam, respond, route, toIso, toIsoOrNull } from './http';
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

export const postInstitutionRequest = route(async (req) => {
  await requestInstitution(await parseBody(req, S.InstitutionRequestBody), clientIp(req));
  return respond(S.Accepted, { status: 'accepted' }, { status: 202 });
});

export const approveInstitution = route(async (req) => {
  const principal = await requireAdmin(req);
  const body = await parseBody(req, S.ApproveBody);
  const result = await approveDomain({ ...body, adminAccountId: principal.account.id });
  return respond(S.Decided, result, { principal });
});

export const rejectInstitution = route(async (req) => {
  const principal = await requireAdmin(req);
  const body = await parseBody(req, S.RejectBody);
  const result = await rejectDomain({ ...body, adminAccountId: principal.account.id });
  return respond(S.Decided, result, { principal });
});
