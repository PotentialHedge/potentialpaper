import { createHash, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { agentCodes, type Account } from '@/db/schema';
import { AGENT_TOKEN_NAME } from '@/lib/agent-prompt';
import { agentCodeMail } from '@/lib/auth-mails';
import { ensureAccountForUser } from './accounts';
import { normalizeEmail } from './affiliations';
import { ApiError } from './api/errors';
import { clientIp } from './api/http';
import { revokeUnprovenAccess } from './better-auth';
import { institutionForEmail } from './institution-domains';
import { sendMail } from './mail';
import { userForEmail } from './onboarding';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './site';
import { mintToken, type MintedToken } from './tokens';

/**
 * How an AI agent signs in for a person (`/agent/start`), as on acceptodds. A signed-in person's prompt
 * carries a code (`issueAgentCode`) and nothing else; a signed-out person's agent asks them for their email,
 * and `requestAgentCode` mails that address a code. Either way `redeemAgentCode` trades the code alone for a
 * `read` + `write` API token named {@link AGENT_TOKEN_NAME}: a code is {@link CODE_LENGTH} characters of
 * Crockford base32 (60 bits), so it names its user by itself and no email travels with it. The inbox is the
 * proof, as for every sign-in here; the agent never sees a password or a session.
 *
 * An address with no account gets a code too: asking makes a Better Auth user for it (no name, no
 * credential, unconfirmed, as onboarding does), and redeeming the code confirms the address, which makes
 * the account (`ensureAccountForUser`). So a person can start with their agent alone.
 *
 * One outstanding code per user, for {@link MAILED_TTL_MS} (mailed) or {@link PROMPT_TTL_MS} (in a prompt).
 * Guessing is bounded per client IP ({@link REDEEM_BUDGET}) rather than per code: a guess names no user.
 * `agent_codes` is written only here.
 */

/** How long a mailed code works. */
export const MAILED_TTL_MS = 30 * 60 * 1000;
/** How long a code in a signed-in person's prompt works. */
export const PROMPT_TTL_MS = 60 * 60 * 1000;
/** Characters in a code; with 32 symbols, 60 bits. */
export const CODE_LENGTH = 12;
/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped survives. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Redemptions per client IP, right or wrong: 20, refilling over an hour. */
const REDEEM_BUDGET: RateLimitConfig = { burst: 20, perSecond: 20 / 3600 };
/** Agent-code mails per address: 5, refilling over a day, like sign-up mails. */
const MAIL_BUDGET: RateLimitConfig = { burst: 5, perSecond: 5 / 86_400 };

/**
 * A code as typed, in its one spelling: upper case, without spaces or dashes, with the letters Crockford's
 * base32 reads as digits (O → 0, I and L → 1). `null` if it cannot be a code.
 */
export function normalizeAgentCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** A code for display, in groups of four: `7K2M-QX9D-4HTB`. */
export function formatAgentCode(code: string): string {
  return code.match(/.{1,4}/g)!.join('-');
}

function newCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/**
 * Mails `email` a code for an agent, replacing any outstanding one. An address with no user gets one made
 * (unconfirmed); the answer is the same either way, so only the inbox learns which. Unlisted domains are
 * refused (the list is public), and each address has a mail budget of its own.
 */
export async function requestAgentCode(rawEmail: string, database: Database = getDb()): Promise<void> {
  const email = normalizeEmail(rawEmail);
  if (!(await institutionForEmail(email, database))) {
    throw new ApiError(
      422,
      'email_domain_not_allowed',
      'accounts are open to approved institutional email domains only, without a +tag',
    );
  }
  const budget = await consume(`agent-code-mail:${email}`, MAIL_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many agent codes mailed to this address; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
  const person = await userForEmail(email, database);
  const { code } = await storeCode(person.id, MAILED_TTL_MS, database);
  await sendMail({ to: email, ...agentCodeMail(code, siteUrl(), { newAccount: !person.emailVerified }) });
}

/**
 * A code for a signed-in person's own prompt (`OnboardAgent`, by session only), which the agent redeems as
 * it would a mailed one. It sits on a clipboard and in a chat log, so it is all the prompt carries.
 */
export async function issueAgentCode(
  account: Account,
  database: Database = getDb(),
): Promise<{ code: string; expiresAt: Date }> {
  const [login] = account.userId
    ? await database.select({ id: user.id }).from(user).where(eq(user.id, account.userId))
    : [];
  if (!login) throw new ApiError(403, 'forbidden', 'this account has no sign-in');
  return storeCode(login.id, PROMPT_TTL_MS, database);
}

/** A new code for this user, replacing any it had. */
async function storeCode(
  userId: string,
  ttlMs: number,
  database: Database,
): Promise<{ code: string; expiresAt: Date }> {
  const code = newCode();
  const row = { codeHash: hashCode(code), expiresAt: new Date(Date.now() + ttlMs), createdAt: new Date() };
  await database
    .insert(agentCodes)
    .values({ userId, ...row })
    .onConflictDoUpdate({ target: agentCodes.userId, set: row });
  return { code: formatAgentCode(code), expiresAt: row.expiresAt };
}

/**
 * A code for a new API token, used up by it. Every failure is the same `invalid_code`, whether the code was
 * never issued, replaced or too old; each try, right or wrong, spends one of the client IP's
 * {@link REDEEM_BUDGET}.
 *
 * The right code for an unconfirmed address confirms it, as a confirmation link would: first dropping any
 * password or session set before the inbox was proven (`revokeUnprovenAccess`), then making the account.
 */
export async function redeemAgentCode(
  input: { code: string },
  req: Request | null,
  database: Database = getDb(),
): Promise<MintedToken & { accountId: string }> {
  const budget = await consume(`agent-code-redeem:${(req && clientIp(req)) ?? 'unknown'}`, REDEEM_BUDGET);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      'too many agent codes tried; try again later',
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
  const code = normalizeAgentCode(input.code);
  const person = !code
    ? null
    : await database.transaction(async (tx) => {
        const [found] = await tx
          .delete(agentCodes)
          .where(eq(agentCodes.codeHash, hashCode(code)))
          .returning({ userId: agentCodes.userId, expiresAt: agentCodes.expiresAt });
        // Used up before the token exists: a failed mint costs a new code, never a second token.
        if (!found || found.expiresAt.getTime() <= Date.now()) return null;
        const [owner] = await tx
          .select({ id: user.id, email: user.email, emailVerified: user.emailVerified })
          .from(user)
          .where(eq(user.id, found.userId));
        if (!owner) return null;
        if (!owner.emailVerified) {
          await revokeUnprovenAccess(owner.id, tx);
          await tx.update(user).set({ emailVerified: true }).where(eq(user.id, owner.id));
        }
        return owner;
      });
  if (!person) {
    throw new ApiError(422, 'invalid_code', 'that code is not a live agent code; ask for a new one');
  }
  // After the commit, like Better Auth's `afterEmailVerification`; idempotent, and repeated lazily by any session.
  const account = await ensureAccountForUser(person, database);
  const minted = await mintToken({ account, name: AGENT_TOKEN_NAME, scopes: ['read', 'write'] }, database);
  return { ...minted, accountId: account.id };
}
