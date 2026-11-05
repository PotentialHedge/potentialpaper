import { cache } from 'react';
import type { Account } from '@/db/schema';
import { ApiError } from './api/errors';
import { ensureAccountForUser } from './accounts';
import { getAuth } from './better-auth';
import { consume, rateLimitConfig, rateLimitHeaders, type RateLimitResult } from './ratelimit';

/**
 * Resolve a request to an account. **The only place that does.** Routes ask for a principal; they never
 * read a cookie themselves. For now the only credential is Better Auth's session cookie; API tokens
 * for bots come with the public API (IMPLEMENTATION.md, milestone 7).
 */

export interface Principal {
  account: Account;
  isAdmin: boolean;
  credentialId: string;
  /** Set when this request was counted against a rate-limit bucket. */
  rateLimit: RateLimitResult | null;
}

/**
 * Human admins, deliberately the simplest thing that works: a signed-in user whose (confirmed) email
 * is in `ADMIN_EMAILS`, comma-separated. Change the list and restart; there is no admin UI for it.
 */
export function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A cookie rides along on any request the browser makes, including one a hostile page triggers. So a
 * state-changing request authenticated by cookie must come from our own origin. (Better Auth's cookies
 * are `SameSite=Lax`, which already stops a cross-site POST carrying them; this is the second lock,
 * and it does not depend on the browser.)
 */
function assertSameOrigin(req: Request): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.get('origin');
  const expected = new URL(process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? req.url).origin;
  if (origin !== expected) {
    throw new ApiError(403, 'forbidden', 'cross-origin request refused for a session-authenticated write');
  }
}

/**
 * `null` when the request carries no session. Every authenticated request is counted against its
 * account's bucket, and a request over the limit is refused with `429 rate_limited`.
 */
export async function authenticate(req: Request): Promise<Principal | null> {
  if (!req.headers.get('cookie')) return null;
  const session = await getAuth().api.getSession({ headers: req.headers });
  // Better Auth refuses sign-in before confirmation; this makes sure an
  // unconfirmed user can never reach the account below either.
  if (!session || !session.user.emailVerified) return null;
  assertSameOrigin(req);

  // Normally created on email confirmation; this makes a missed hook harmless.
  const account = await ensureAccountForUser(session.user);
  const rateLimit = await consume(`user:${session.user.id}`, rateLimitConfig());
  if (!rateLimit.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many requests for this account',
      { retryAfterSeconds: rateLimit.retryAfterSeconds },
      rateLimitHeaders(rateLimit),
    );
  }
  return { account, isAdmin: isAdminEmail(session.user.email), credentialId: session.session.id, rateLimit };
}

/** A principal, or a 401. */
export async function requireAuth(req: Request): Promise<Principal> {
  const principal = await authenticate(req);
  if (!principal) throw new ApiError(401, 'unauthorized', 'sign in required');
  return principal;
}

/** A principal whose email is in `ADMIN_EMAILS`, or a 401/403. */
export async function requireAdmin(req: Request): Promise<Principal> {
  const principal = await requireAuth(req);
  if (!principal.isAdmin) throw new ApiError(403, 'forbidden', 'admins only');
  return principal;
}

/** A principal with a confirmed institutional address, the gate on everything that writes to a page. */
export async function requireVerified(req: Request): Promise<Principal> {
  const principal = await requireAuth(req);
  if (!principal.account.isBot && !principal.account.verifiedAt) {
    throw new ApiError(403, 'not_verified', 'confirm an institutional email address first');
  }
  return principal;
}

/** A page's signed-in viewer. */
export interface Viewer {
  account: Account;
  isAdmin: boolean;
  email: string;
}

/**
 * The signed-in viewer of a server-rendered page, or `null`. For Server Components only: read-only, so
 * it neither counts against the rate limit nor checks Origin. Anything that writes goes through the
 * API (or through `authenticate()`), never through this.
 */
export async function viewerFromHeaders(headers: Headers): Promise<Viewer | null> {
  const cookie = headers.get('cookie');
  if (!cookie) return null;
  return viewerForCookie(cookie);
}

const viewerForCookie = cache(async (cookie: string): Promise<Viewer | null> => {
  const session = await getAuth().api.getSession({ headers: new Headers({ cookie }) });
  if (!session || !session.user.emailVerified) return null;
  const account = await ensureAccountForUser(session.user);
  return { account, isAdmin: isAdminEmail(session.user.email), email: session.user.email };
});
