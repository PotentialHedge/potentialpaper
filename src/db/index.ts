import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

/** Plain TCP `pg`: commits to a page need real interactive transactions. */
function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  }
  return url;
}

/** A stuck client must not hold a row lock forever. */
const STATEMENT_TIMEOUT_MS = 15_000;

export function createPool(url: string = connectionString(), statementTimeoutMs = STATEMENT_TIMEOUT_MS): Pool {
  return new Pool({
    connectionString: url,
    max: Number(process.env.PGPOOL_MAX ?? 10),
    statement_timeout: statementTimeoutMs,
    idle_in_transaction_session_timeout: STATEMENT_TIMEOUT_MS,
  });
}

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Database = ReturnType<typeof createDb>;

declare global {
  var __potentialpaperPool: Pool | undefined;
}

/**
 * One pool per process, created on first use.
 *
 * Lazy on purpose: `next build` imports every route module, and a build must
 * not need a database. It is cached on `globalThis` outside production because
 * `next dev` re-evaluates modules on every edit and would otherwise exhaust
 * Postgres's connection slots within a minute.
 */
export function getPool(): Pool {
  const existing = globalThis.__potentialpaperPool;
  if (existing) return existing;
  const created = createPool();
  globalThis.__potentialpaperPool = created;
  return created;
}

let cachedDb: Database | undefined;

export function getDb(): Database {
  cachedDb ??= createDb(getPool());
  return cachedDb;
}

/** Used by `/healthz`: a 200 that never touched Postgres is not a health check. */
export async function checkDatabase(): Promise<void> {
  await getDb().execute(sql`select 1`);
}
