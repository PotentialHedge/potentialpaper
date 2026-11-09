import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, apiTokens, TOKEN_SCOPES, type Account, type TokenScope } from '@/db/schema';

/**
 * API tokens: `pp_live_` + 32 random bytes (base64url), shown **once**, when made. Only the SHA-256 is
 * stored, and a presented token is looked up by it, so there is nothing to compare byte by byte and
 * nothing useful in the table. Nothing outside `server/auth.ts` should call `verifyToken`.
 */

export const TOKEN_PREFIX = 'pp_live_';
const TOKEN_PATTERN = /^pp_live_[A-Za-z0-9_-]{43}$/;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface MintedToken {
  /** The secret. Returned here and nowhere else, ever. */
  token: string;
  id: string;
  name: string;
  scopes: TokenScope[];
}

export async function mintToken(
  input: { account: Account; name: string; scopes: TokenScope[] },
  database: Database = getDb(),
): Promise<MintedToken> {
  const scopes = TOKEN_SCOPES.filter((s) => input.scopes.includes(s));
  if (scopes.length === 0) throw new Error('a token needs at least one scope');
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const [row] = await database
    .insert(apiTokens)
    .values({
      accountId: input.account.id,
      name: input.name,
      tokenHash: hashToken(token),
      start: token.slice(0, 16),
      scopes,
    })
    .returning({ id: apiTokens.id });
  return { token, id: row.id, name: input.name, scopes };
}

export interface VerifiedToken {
  id: string;
  account: Account;
  scopes: TokenScope[];
}

/**
 * The token's account and scopes, or `null` if it is malformed, unknown or revoked. Never throws for a
 * bad token: the caller turns `null` into a 401.
 */
export async function verifyToken(token: string, database: Database = getDb()): Promise<VerifiedToken | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [row] = await database
    .select({ token: apiTokens, account: accounts })
    .from(apiTokens)
    .innerJoin(accounts, eq(accounts.id, apiTokens.accountId))
    .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt)));
  if (!row) return null;
  await database.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.token.id));
  return { id: row.token.id, account: row.account, scopes: row.token.scopes };
}

export async function listTokens(accountId: string, database: Database = getDb()) {
  return database
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      start: apiTokens.start,
      scopes: apiTokens.scopes,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.accountId, accountId), isNull(apiTokens.revokedAt)))
    .orderBy(desc(apiTokens.createdAt));
}

/** Revoke a token. `false` if the account has no such live token. */
export async function revokeToken(accountId: string, tokenId: string, database: Database = getDb()): Promise<boolean> {
  const updated = await database
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.accountId, accountId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  return updated.length > 0;
}
