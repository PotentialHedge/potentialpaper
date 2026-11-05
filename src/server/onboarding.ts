import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { isUniqueViolation } from '@/db/errors';
import { accounts } from '@/db/schema';
import { authHref, VERIFY_EMAIL } from '@/lib/return-to';
import { normalizeEmail } from './affiliations';
import { ApiError } from './api/errors';
import { getAuth, mailExistingAccount } from './better-auth';
import { institutionForEmail } from './institution-domains';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';

/**
 * Onboarding, the way to sign up: an email, with no name and no password. That makes a Better Auth
 * user **without a credential**, and mails a confirmation link and code. Confirming creates the
 * account (`ensureAccountForUser`) and signs in; the person lands on `/verify-email`, which asks for
 * their public profile and a password. A password is never taken before the address is proven, so
 * nobody can attach one to an address they do not own (Better Auth's own `/sign-up/email` is off).
 *
 * Answers the same whether or not the address is taken: a confirmed one gets a mail saying it has an
 * account, with a sign-in link and a code; an unconfirmed one gets a fresh confirmation mail.
 */

/**
 * Sign-up mails per address: 5, refilling over a day. The route is anonymous and sends mail; the edge
 * limits by IP, this limits what any number of IPs can send to one inbox.
 */
const MAIL_BUDGET: RateLimitConfig = { burst: 5, perSecond: 5 / 86_400 };

export async function startOnboarding(
  input: { email: string; next?: string },
  database: Database = getDb(),
): Promise<void> {
  const email = normalizeEmail(input.email);
  if (!(await institutionForEmail(email, database))) {
    throw new ApiError(
      422,
      'email_domain_not_allowed',
      'sign-up is open to approved institutional email domains only, without a +tag',
    );
  }
  const budget = await consume(`signup-mail:${email}`, MAIL_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many sign-up emails to this address; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }

  const person = await userForEmail(email, database);
  const callbackURL = authHref(VERIFY_EMAIL, input.next ?? '/');
  if (person.emailVerified) await mailExistingAccount(email, callbackURL);
  else await getAuth().api.sendVerificationEmail({ body: { email, callbackURL } });
}

/** The user for `email`, made if there is none: no credential, unconfirmed. Two sign-ups at once: the other one won. */
async function userForEmail(email: string, database: Database): Promise<{ id: string; emailVerified: boolean }> {
  const find = async () => {
    const [row] = await database
      .select({ id: user.id, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.email, email));
    return row ?? null;
  };
  const existing = await find();
  if (existing) return existing;
  try {
    const ctx = await getAuth().$context;
    await ctx.internalAdapter.createUser({ email, name: '', emailVerified: false }, { method: 'signup' });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const made = await find();
  if (!made) throw new Error(`user ${email} vanished after creation`);
  return made;
}

/** Give a user who signed up through onboarding their first password. Better Auth's `setPassword` is server-only. */
export async function setFirstPassword(headers: Headers, password: string): Promise<void> {
  try {
    await getAuth().api.setPassword({ body: { newPassword: password }, headers });
  } catch (err) {
    const code = (err as { body?: { code?: string } }).body?.code;
    if (code === 'PASSWORD_ALREADY_SET')
      throw new ApiError(409, 'password_already_set', 'this account already has a password');
    if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG') {
      throw new ApiError(400, 'validation_error', 'password must be 12 to 128 characters');
    }
    throw err;
  }
}

/** How long an unconfirmed sign-up is kept: a confirmation lasts an hour, so a week is generous. */
export const UNCONFIRMED_USER_TTL_DAYS = 7;

/**
 * Delete the Better Auth users onboarding made whose address was never confirmed, once they are
 * `olderThanDays` old (`npm run users:prune`, weekly from the host's cron). Anyone can make one for
 * any allowlisted address, so without this they pile up. Never a user with an account. Returns how many.
 */
export async function pruneUnconfirmedUsers(
  { olderThanDays = UNCONFIRMED_USER_TTL_DAYS, now = new Date() }: { olderThanDays?: number; now?: Date } = {},
  database: Database = getDb(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);
  const deleted = await database
    .delete(user)
    .where(
      and(
        eq(user.emailVerified, false),
        lt(user.createdAt, cutoff),
        sql`not exists (select 1 from ${accounts} where ${accounts.userId} = ${user.id})`,
      ),
    )
    .returning({ id: user.id });
  return deleted.length;
}
