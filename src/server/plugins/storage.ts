import { and, eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { userPluginStorage, type Account } from '@/db/schema';
import { MAX_STORAGE_BYTES } from '@/lib/plugins/protocol';
import { PLUGIN_ID_RE } from '@/lib/settings/spec';
import { ApiError } from '../api/errors';

/**
 * A plugin's small state for one account (`storage.get`, `storage.set`): one JSON object per account and plugin, at
 * most 64 KB, in Postgres, so it follows the account between browsers. Not shared with anyone: plugins never write
 * state other readers see (DESIGN.md §10). A plugin's cache belongs in its own origin's IndexedDB instead.
 */

const MAX_PLUGINS_PER_ACCOUNT = 200;

function checkId(pluginId: string) {
  if (!PLUGIN_ID_RE.test(pluginId)) throw new ApiError(422, 'validation_error', 'not a plugin id');
}

export function storageBytes(data: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(data));
}

export async function pluginStorage(
  account: Account,
  pluginId: string,
  database: Database = getDb(),
): Promise<Record<string, unknown>> {
  checkId(pluginId);
  const [row] = await database
    .select({ data: userPluginStorage.data })
    .from(userPluginStorage)
    .where(and(eq(userPluginStorage.accountId, account.id), eq(userPluginStorage.pluginId, pluginId)));
  return row?.data ?? {};
}

/** Set one key (`null` or `undefined` removes it); refused, with nothing changed, past 64 KB. */
export async function setPluginStorage(
  account: Account,
  pluginId: string,
  key: string,
  value: unknown,
  database: Database = getDb(),
): Promise<Record<string, unknown>> {
  checkId(pluginId);
  return database.transaction(async (tx) => {
    const [row] = await tx
      .select({ data: userPluginStorage.data })
      .from(userPluginStorage)
      .where(and(eq(userPluginStorage.accountId, account.id), eq(userPluginStorage.pluginId, pluginId)))
      .for('update');
    if (!row) {
      const [{ n }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(userPluginStorage)
        .where(eq(userPluginStorage.accountId, account.id));
      if (n >= MAX_PLUGINS_PER_ACCOUNT) {
        throw new ApiError(422, 'storage_full', `storage is kept for at most ${MAX_PLUGINS_PER_ACCOUNT} plugins`);
      }
    }
    const data = { ...(row?.data ?? {}) };
    if (value === null || value === undefined) delete data[key];
    else data[key] = value;
    if (storageBytes(data) > MAX_STORAGE_BYTES) {
      throw new ApiError(
        413,
        'storage_full',
        `a plugin keeps at most ${MAX_STORAGE_BYTES / 1024} KB per account; this would be ${Math.ceil(storageBytes(data) / 1024)} KB`,
      );
    }
    await tx
      .insert(userPluginStorage)
      .values({ accountId: account.id, pluginId, data })
      .onConflictDoUpdate({
        target: [userPluginStorage.accountId, userPluginStorage.pluginId],
        set: { data, updatedAt: new Date() },
      });
    return data;
  });
}
