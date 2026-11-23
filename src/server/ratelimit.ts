import { getPool } from '@/db';
import type { Pool } from 'pg';

/**
 * Per-credential rate limiting: a token bucket, as one row in Postgres,
 * updated in the request it limits. Cheaper than a
 * Redis at this scale, and the row lock makes it correct under concurrency.
 *
 * This is the **inner** layer. Anonymous traffic is limited at the edge —
 * Cloudflare, then Traefik keyed on `Cf-Connecting-Ip` — and never here.
 *
 * The bucket holds up to `burst` requests and refills at `perSecond`. The
 * clock is Postgres's (`clock_timestamp()`), not this process's, so several
 * app replicas agree on it.
 */

export interface RateLimitConfig {
  burst: number;
  perSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  /** Whole requests left in the bucket after this one. */
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSeconds: number;
  /** Seconds until one request would be allowed; 0 when `allowed`. */
  retryAfterSeconds: number;
}

/**
 * A signed-in account's bucket. `trusted`, for admins and bots (accounts only we make), is far larger, so our own
 * imports and scripts are never held to a person's pace: `API_RATE_LIMIT_TRUSTED_*`.
 */
export function rateLimitConfig(trusted = false): RateLimitConfig {
  const prefix = trusted ? 'API_RATE_LIMIT_TRUSTED' : 'API_RATE_LIMIT';
  const burst = Number(process.env[`${prefix}_BURST`] ?? (trusted ? 2_000 : 60));
  const perSecond = Number(process.env[`${prefix}_PER_SECOND`] ?? (trusted ? 200 : 2));
  if (!(burst >= 1) || !(perSecond > 0)) {
    throw new Error(`${prefix}_BURST must be >= 1 and ${prefix}_PER_SECOND > 0`);
  }
  return { burst, perSecond };
}

/**
 * An account's bucket: a bot's own limit when an admin set one (`bots:limit`), else the trusted bucket for bots and
 * admins, else a person's. A person's account never has its own, whatever its row says.
 */
export function accountRateLimit(
  account: { isBot: boolean; rateLimitPerSecond: number | null; rateLimitBurst: number | null },
  trusted: boolean,
): RateLimitConfig {
  const { isBot, rateLimitPerSecond: perSecond, rateLimitBurst: burst } = account;
  if (isBot && perSecond !== null && burst !== null && perSecond > 0 && burst >= 1) return { perSecond, burst };
  return rateLimitConfig(trusted);
}

/** Take one request from `key`'s bucket, if there is one to take. */
export async function consume(
  key: string,
  config: RateLimitConfig = rateLimitConfig(),
  pool: Pool = getPool(),
): Promise<RateLimitResult> {
  const { burst, perSecond } = config;
  const client = await pool.connect();
  try {
    await client.query('begin');
    // Create the bucket full on first sight, then lock it. Two statements
    // because `on conflict do update` cannot tell us whether it refused.
    await client.query(
      `insert into rate_limit_buckets (key, tokens, updated_at)
       values ($1, $2, clock_timestamp())
       on conflict (key) do nothing`,
      [key, burst],
    );
    const { rows } = await client.query<{ tokens: number; elapsed: number }>(
      `select tokens,
              extract(epoch from clock_timestamp() - updated_at)::float8 as elapsed
         from rate_limit_buckets where key = $1 for update`,
      [key],
    );
    const refilled = Math.min(burst, rows[0].tokens + Math.max(0, rows[0].elapsed) * perSecond);
    const allowed = refilled >= 1;
    const after = allowed ? refilled - 1 : refilled;
    await client.query(`update rate_limit_buckets set tokens = $2, updated_at = clock_timestamp() where key = $1`, [
      key,
      after,
    ]);
    await client.query('commit');

    return {
      allowed,
      limit: burst,
      remaining: Math.floor(after),
      resetSeconds: Math.ceil((burst - after) / perSecond),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - after) / perSecond)),
    };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(r.limit),
    'X-RateLimit-Remaining': String(r.remaining),
    'X-RateLimit-Reset': String(r.resetSeconds),
  };
  if (!r.allowed) headers['Retry-After'] = String(r.retryAfterSeconds);
  return headers;
}
