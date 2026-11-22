import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { user } from '@/db/auth-schema';
import { agentLinks, type Account } from '@/db/schema';
import { AGENT_TOKEN_NAME } from '@/lib/agent-prompt';
import { ensureAccountForUser } from './accounts';
import { ApiError } from './api/errors';
import { clientIp } from './api/http';
import { consume, rateLimitHeaders, type RateLimitConfig } from './ratelimit';
import { siteUrl } from './site';
import { mintToken, type MintedToken } from './tokens';

/**
 * Signing an agent in through the person's browser, like a device login. The agent asks for a link
 * (`startAgentLink`) and gets two things: an address to open, `/agent/connect/<id>`, and a secret it keeps. The
 * person opens the address, signs in there if they are not (or signs up: the sign-in page makes an account for a new
 * address, and onboarding then asks for a handle), and approves (`approveAgentLink`, by session only). Meanwhile the
 * agent polls with its secret (`pollAgentLink`) and, once approved, gets a `read` + `write` token named
 * {@link AGENT_TOKEN_NAME}, the same as a code would give it.
 *
 * The id in the address is not a secret: approving needs the person's session, and only the secret's holder gets the
 * token. The page tells the person to approve only a link their own agent gave them just now. A link works for
 * {@link LINK_TTL_MS}, gives one token, and is gone after. `agent_links` is written only here.
 */

/** How long a link may wait for the person. */
export const LINK_TTL_MS = 15 * 60 * 1000;
/** Characters in a link's id; Crockford base32, as agent codes. */
const ID_LENGTH = 8;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Links asked for per client IP: 20, refilling over an hour. Anonymous, and each is a row. */
const START_BUDGET: RateLimitConfig = { burst: 20, perSecond: 20 / 3600 };
/** Polls per client IP: enough to ask every few seconds for a link's whole life. Secrets can't be guessed. */
const POLL_BUDGET: RateLimitConfig = { burst: 300, perSecond: 1 };

function hash(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** An id as typed or linked, in its one spelling (upper case, no dashes), or `null` if it cannot be one. */
export function normalizeLinkId(raw: string): string | null {
  const id = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return id.length === ID_LENGTH && [...id].every((c) => ALPHABET.includes(c)) ? id : null;
}

export function formatLinkId(id: string): string {
  return `${id.slice(0, 4)}-${id.slice(4)}`;
}

export function agentLinkUrl(id: string): string {
  return `${siteUrl()}/agent/connect/${formatLinkId(id)}`;
}

async function spend(req: Request | null, bucket: string, config: RateLimitConfig, what: string): Promise<void> {
  const budget = await consume(`${bucket}:${(req && clientIp(req)) ?? 'unknown'}`, config);
  if (!budget.allowed) {
    throw new ApiError(
      429,
      'rate_limited',
      `too many ${what}; try again later`,
      { retryAfterSeconds: budget.retryAfterSeconds },
      rateLimitHeaders(budget),
    );
  }
}

export interface StartedLink {
  url: string;
  /** Only the agent has it; it trades it for the token. */
  secret: string;
  expiresAt: Date;
}

export async function startAgentLink(
  input: { agent?: string },
  req: Request | null,
  database: Database = getDb(),
): Promise<StartedLink> {
  await spend(req, 'agent-link-start', START_BUDGET, 'sign-in links asked for');
  // Expired links are never read again; clear them as new ones come.
  await database.delete(agentLinks).where(lt(agentLinks.expiresAt, new Date()));
  const secret = `ppl_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + LINK_TTL_MS);
  let id = '';
  for (let i = 0; i < ID_LENGTH; i += 1) id += ALPHABET[randomInt(ALPHABET.length)];
  await database.insert(agentLinks).values({
    id,
    secretHash: hash(secret),
    agent: (input.agent ?? '').trim().slice(0, 120),
    expiresAt,
  });
  return { url: agentLinkUrl(id), secret, expiresAt };
}

/** A live link, for `/agent/connect/<id>`, or `null` when there is none (never was, used, declined or too old). */
export async function agentLink(
  rawId: string,
  database: Database = getDb(),
): Promise<{ id: string; agent: string; approved: boolean; expiresAt: Date } | null> {
  const id = normalizeLinkId(rawId);
  if (!id) return null;
  const [row] = await database
    .select()
    .from(agentLinks)
    .where(and(eq(agentLinks.id, id), gt(agentLinks.expiresAt, new Date())));
  return row ? { id: row.id, agent: row.agent, approved: row.userId !== null, expiresAt: row.expiresAt } : null;
}

/** The signed-in person lets the link's agent act as them (`approve`), or says no, which ends the link. */
export async function answerAgentLink(
  rawId: string,
  account: Account,
  approve: boolean,
  database: Database = getDb(),
): Promise<void> {
  const id = normalizeLinkId(rawId);
  if (!account.userId) throw new ApiError(403, 'forbidden', 'this account has no sign-in');
  const live = id && and(eq(agentLinks.id, id), gt(agentLinks.expiresAt, new Date()), isNull(agentLinks.userId));
  const done = !live
    ? []
    : approve
      ? await database.update(agentLinks).set({ userId: account.userId }).where(live).returning({ id: agentLinks.id })
      : await database.delete(agentLinks).where(live).returning({ id: agentLinks.id });
  if (done.length === 0) {
    throw new ApiError(
      410,
      'link_closed',
      'this sign-in link was already used, or is too old; ask your agent for a new one',
    );
  }
}

/**
 * The agent asks whether the person has approved: `pending` until they do, then the token, once. `link_closed` when
 * the link was declined, used or ran out: start a new one.
 */
export async function pollAgentLink(
  input: { secret: string },
  req: Request | null,
  database: Database = getDb(),
): Promise<{ status: 'pending'; expiresAt: Date } | ({ status: 'approved' } & MintedToken)> {
  await spend(req, 'agent-link-poll', POLL_BUDGET, 'polls');
  const secretHash = hash(input.secret.trim());
  const [row] = await database.select().from(agentLinks).where(eq(agentLinks.secretHash, secretHash));
  if (!row || row.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(
      410,
      'link_closed',
      'this sign-in link was declined, already used, or is too old; start a new one',
    );
  }
  if (!row.userId) return { status: 'pending', expiresAt: row.expiresAt };
  // Used up before the token exists: a second poll racing this one finds nothing.
  const [taken] = await database
    .delete(agentLinks)
    .where(eq(agentLinks.secretHash, secretHash))
    .returning({ userId: agentLinks.userId });
  if (!taken?.userId) throw new ApiError(410, 'link_closed', 'this sign-in link was already used; start a new one');
  const [owner] = await database.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, taken.userId));
  if (!owner) throw new ApiError(410, 'link_closed', 'this sign-in link was already used; start a new one');
  const account = await ensureAccountForUser(owner, database);
  const minted = await mintToken({ account, name: AGENT_TOKEN_NAME, scopes: ['read', 'write'] }, database);
  return { status: 'approved', ...minted };
}
