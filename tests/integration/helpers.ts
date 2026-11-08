/* eslint-disable @typescript-eslint/no-explicit-any -- response bodies are checked field by field */
import { sql } from 'drizzle-orm';
import * as authRoute from '@/app/api/auth/[...all]/route';
import * as me from '@/app/api/v1/me/route';
import * as affiliations from '@/app/api/v1/me/affiliations/route';
import * as affiliation from '@/app/api/v1/me/affiliations/[id]/route';
import * as affiliationVerify from '@/app/api/v1/me/affiliations/[id]/verify/route';
import * as password from '@/app/api/v1/me/password/route';
import * as onboarding from '@/app/api/v1/onboarding/route';
import * as demos from '@/app/api/v1/demos/route';
import * as pageEdit from '@/app/api/v1/pages/edit/route';
import * as pageRender from '@/app/api/v1/pages/render/route';
import * as pageRevert from '@/app/api/v1/pages/revert/route';
import * as pageLinks from '@/app/api/v1/pages/links/route';
import * as pageThumbnail from '@/app/api/v1/pages/thumbnail/route';
import * as claims from '@/app/api/v1/claims/route';
import { getDb, getPool } from '@/db';
import { clearDevOutbox, devOutbox } from '@/server/mail';

export const ORIGIN = 'http://test.local';

export async function resetDatabase(): Promise<void> {
  await getDb().execute(sql`
    truncate table author_claims, demo_snapshots, submission_notes, submissions, venues, pdf_covers, page_events, page_current, page_revisions, page_refs, page_objects, commit_identities, paper_lookup_misses, paper_identifiers, papers, institution_domains, affiliations, accounts, rate_limit_buckets,
      session, account, verification, "user"
    restart identity cascade
  `);
  clearDevOutbox();
}

export async function closePool(): Promise<void> {
  await getPool()
    .end()
    .catch(() => {});
}

const ROUTES: [RegExp, any][] = [
  [/^\/onboarding$/, onboarding],
  [/^\/me$/, me],
  [/^\/demos(\?.*)?$/, demos],
  [/^\/pages\/edit$/, pageEdit],
  [/^\/pages\/render$/, pageRender],
  [/^\/pages\/revert$/, pageRevert],
  [/^\/pages\/links$/, pageLinks],
  [/^\/pages\/thumbnail(\?.*)?$/, pageThumbnail],
  [/^\/claims(\?.*)?$/, claims],
  [/^\/me\/password$/, password],
  [/^\/me\/affiliations$/, affiliations],
  [/^\/me\/affiliations\/(?<id>[^/]+)$/, affiliation],
  [/^\/me\/affiliations\/(?<id>[^/]+)\/verify$/, affiliationVerify],
];

export interface ApiResult {
  status: number;
  body: any;
}

/** A request through the real route handler, as Next would make it. */
export async function api(
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; origin?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { origin: opts.origin ?? ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(new URL(`/api/v1${path}`, ORIGIN), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  for (const [pattern, module] of ROUTES) {
    const match = pattern.exec(path);
    if (match) {
      const res: Response = await module[method](request, { params: Promise.resolve({ ...match.groups }) });
      return { status: res.status, body: await res.json().catch(() => null) };
    }
  }
  throw new Error(`no route for ${path}`);
}

export async function authCall(method: 'GET' | 'POST', path: string, opts: { cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(new URL(`/api/auth${path}`, ORIGIN), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return (method === 'GET' ? authRoute.GET : authRoute.POST)(request);
}

export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

export function lastMailTo(email: string) {
  return [...devOutbox()].reverse().find((m) => m.to === email);
}

/** The whole way in, through the real endpoints: an email, the code from the mail. Returns the session cookie. */
export async function signUp(email: string): Promise<string> {
  const started = await api('POST', '/onboarding', { body: { email } });
  if (started.status !== 202) throw new Error(`sign-up failed: ${started.status} ${JSON.stringify(started.body)}`);
  const mail = lastMailTo(email);
  const code = /\b(\d{6})\b/.exec(mail?.subject ?? '')?.[1];
  if (!code) throw new Error(`no code in mail: ${mail?.subject}`);
  const confirmed = await authCall('POST', '/email-otp/verify-email', { body: { email, otp: code } });
  const cookie = cookieFrom(confirmed);
  if (!cookie.includes('session_token')) throw new Error(`no session: ${confirmed.status} ${await confirmed.text()}`);
  return cookie;
}
