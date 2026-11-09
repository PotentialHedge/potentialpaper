import { cache } from 'react';
import type { Account } from '@/db/schema';
import { ApiError } from './api/errors';
import { ensureAccountForUser } from './accounts';
import { getAuth } from './better-auth';
import { consume, rateLimitConfig, rateLimitHeaders, type RateLimitResult } from './ratelimit';
import { verifyToken } from './tokens';

/**
 * Resolve a request to an account. **The only place that does.** Routes ask for a principal; they never
 * read a cookie themselves. Two credentials: Better Auth's session cookie, and an API token
 * (`Authorization: Bearer pp_live_…`, `server/tokens.ts`), which is how an agent acts for a person.
 */

export interface Principal {
  account: Account;
  isAdmin: boolean;
  credentialId: string;
  /** How the request signed in: a browser session, or an API token (an agent). */
  via: 'session' | 'token';
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
  const bearer = req.headers.get('authorization');
  if (bearer) return authenticateToken(req, bearer);
  if (!req.headers.get('cookie')) return null;
  const session = await getAuth().api.getSession({ headers: req.headers });
  // Better Auth refuses sign-in before confirmation; this makes sure an
  // unconfirmed user can never reach the account below either.
  if (!session || !session.user.emailVerified) return null;
  assertSameOrigin(req);

  // Normally created on email confirmation; this makes a missed hook harmless.
  const account = await ensureAccountForUser(session.user);
  const rateLimit = await countRequest(`user:${session.user.id}`);
  return {
    account,
    isAdmin: isAdminEmail(session.user.email),
    credentialId: session.session.id,
    via: 'session',
    rateLimit,
  };
}

/**
 * A request with an `Authorization` header: a valid token or a 401, never a fall back to the cookie. No
 * Origin check, as a browser never adds this header by itself. A token is never an admin, and one without
 * the `write` scope may only read.
 */
async function authenticateToken(req: Request, header: string): Promise<Principal> {
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const verified = match && (await verifyToken(match[1]));
  if (!verified) throw new ApiError(401, 'unauthorized', 'invalid or revoked API token');
  if (!SAFE_METHODS.has(req.method) && !verified.scopes.includes('write')) {
    throw new ApiError(403, 'forbidden', 'this token may only read');
  }
  const rateLimit = await countRequest(`account:${verified.account.id}`);
  return { account: verified.account, isAdmin: false, credentialId: verified.id, via: 'token', rateLimit };
}

/** One request from the credential's bucket, or a 429. */
async function countRequest(key: string): Promise<RateLimitResult> {
  const rateLimit = await consume(key, rateLimitConfig());
  if (!rateLimit.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many requests for this account',
      { retryAfterSeconds: rateLimit.retryAfterSeconds },
      rateLimitHeaders(rateLimit),
    );
  }
  return rateLimit;
}

/** A principal, or a 401. */
export async function requireAuth(req: Request): Promise<Principal> {
  const principal = await authenticate(req);
  if (!principal) throw new ApiError(401, 'unauthorized', 'sign in required');
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

/** A principal signed in by a browser session, for what only the person may do (minting a code for their agent). */
export async function requireSession(req: Request): Promise<Principal> {
  const principal = await requireAuth(req);
  if (principal.via !== 'session') throw new ApiError(403, 'forbidden', 'sign in in a browser for this');
  return principal;
}
