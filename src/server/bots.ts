import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, botGrants } from '@/db/schema';
import type { PageKind } from '@/lib/kinds';
import type { Actor } from './pages/check';
import { grantProblem } from './pages/rules';

/**
 * Bots (DESIGN.md §10): accounts marked `is_bot`, whose commits carry `Bot: true`, with write grants on path
 * patterns as rows (`bot_grants`), checked by the same path rules as everyone (`rules.ts`). Admins grant them by
 * script (`npm run bots:grant`). Registration by outsiders, short-lived tokens and webhooks come with Milestone 7.
 */

/** Our OpenReview importer, the first bot: it writes `reviews/openreview/**` (granted by migration `0027`). */
export const OPENREVIEW_BOT = 'openreview';

/** A bot's actor, by handle. Refuses an account that isn't a bot. */
export async function botActor(handle: string, database: Database = getDb()): Promise<Actor> {
  const [row] = await database
    .select({ id: accounts.id, isBot: accounts.isBot })
    .from(accounts)
    .where(eq(accounts.handle, handle));
  if (!row) throw new Error(`no bot with the handle ${handle}`);
  if (!row.isBot) throw new Error(`${handle} is not a bot`);
  return { kind: 'account', accountId: row.id, isAdmin: false };
}

/** Makes the bot account if there is none by that handle; refuses if a person has it. */
export async function ensureBot(handle: string, database: Database = getDb()): Promise<Actor> {
  await database
    .insert(accounts)
    .values({
      handle,
      isBot: true,
      verifiedAt: sql`clock_timestamp()`,
      profileCompletedAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing();
  return botActor(handle, database);
}

export interface Grant {
  handle: string;
  /** The kind of page the pattern applies to. */
  kind: PageKind;
  pattern: string;
  shown: boolean;
  grantedBy: string;
  createdAt: Date;
}

/**
 * Grants a bot a path pattern on pages of a kind, a paper's by default (`grantProblem` says which are allowed).
 * Granting it again changes `shown`.
 */
export async function grantBot(
  handle: string,
  pattern: string,
  {
    grantedBy,
    shown = true,
    kind = 'paper',
    database = getDb(),
  }: { grantedBy: string; shown?: boolean; kind?: PageKind; database?: Database },
): Promise<void> {
  const problem = grantProblem(pattern, kind);
  if (problem) throw new Error(problem);
  const actor = await botActor(handle, database);
  if (actor.kind !== 'account') throw new Error('unreachable');
  await database
    .insert(botGrants)
    .values({ accountId: actor.accountId, kind, pattern, shown, grantedBy })
    .onConflictDoUpdate({
      target: [botGrants.accountId, botGrants.kind, botGrants.pattern],
      set: { shown, grantedBy },
    });
}

/** Takes a grant back. Whether there was one. */
export async function revokeGrant(
  handle: string,
  pattern: string,
  database: Database = getDb(),
  kind: PageKind = 'paper',
): Promise<boolean> {
  const actor = await botActor(handle, database);
  if (actor.kind !== 'account') throw new Error('unreachable');
  const removed = await database
    .delete(botGrants)
    .where(and(eq(botGrants.accountId, actor.accountId), eq(botGrants.kind, kind), eq(botGrants.pattern, pattern)))
    .returning({ pattern: botGrants.pattern });
  return removed.length > 0;
}

export async function listGrants(database: Database = getDb()): Promise<Grant[]> {
  return database
    .select({
      handle: accounts.handle,
      kind: botGrants.kind,
      pattern: botGrants.pattern,
      shown: botGrants.shown,
      grantedBy: botGrants.grantedBy,
      createdAt: botGrants.createdAt,
    })
    .from(botGrants)
    .innerJoin(accounts, eq(accounts.id, botGrants.accountId))
    .orderBy(accounts.handle, botGrants.kind, botGrants.pattern);
}

export interface BotLimit {
  handle: string;
  /** `null`: the trusted bucket (`rateLimitConfig(true)`). */
  perSecond: number | null;
  burst: number | null;
}

/** Every bot with its own request limit, if it has one (`bots:limit`). */
export async function listBotLimits(database: Database = getDb()): Promise<BotLimit[]> {
  const rows = await database
    .select({ handle: accounts.handle, perSecond: accounts.rateLimitPerSecond, burst: accounts.rateLimitBurst })
    .from(accounts)
    .where(eq(accounts.isBot, true))
    .orderBy(accounts.handle);
  return rows.map((row) => ({ ...row, handle: row.handle ?? '' }));
}

/**
 * Sets a bot's own request limit (`accountRateLimit`), or with `null` takes it back to the trusted bucket. Whether
 * there was such a bot.
 */
export async function setBotLimit(
  handle: string,
  limit: { perSecond: number; burst: number } | null,
  database: Database = getDb(),
): Promise<boolean> {
  if (limit && !(limit.perSecond > 0 && Number.isInteger(limit.burst) && limit.burst >= 1)) {
    throw new Error('the limit needs --per-second above 0 and a whole --burst of at least 1');
  }
  const updated = await database
    .update(accounts)
    .set({ rateLimitPerSecond: limit?.perSecond ?? null, rateLimitBurst: limit?.burst ?? null })
    .where(and(eq(accounts.handle, handle), eq(accounts.isBot, true)))
    .returning({ id: accounts.id });
  return updated.length > 0;
}
