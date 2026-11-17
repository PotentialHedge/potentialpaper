import {
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from 'node:crypto';
import { desc, eq, isNull } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { identityKeys, type Account } from '@/db/schema';
import { runningPermissions } from '@/lib/plugins/installed';
import { PLUGIN_ID_RE } from '@/lib/settings/spec';
import { ApiError } from '../api/errors';
import { siteUrl } from '../site';
import { installedPlugins } from './installed';

/**
 * Identity for plugins' own backends (`handoffs/plugins.md` Phase 5, DESIGN.md §10, "data for plugins D"). A plugin
 * with the `identity` permission calls `pp.identity.token()`, and the site signs a short-lived JWT naming the reader
 * and the plugin, its audience the plugin's id. The plugin sends it to its backend (one of its `network` origins),
 * which checks it against `/.well-known/jwks.json`: the backend learns who the reader is without ever seeing their
 * session, and a token taken from one plugin is refused by every other plugin's backend.
 *
 * The token (ES256, `typ: JWT`, `kid` the key's RFC 7638 thumbprint):
 *
 *     { iss: <site origin>, aud: <plugin id>, sub: "p_…", handle: "ada", plugin: <plugin id>,
 *       iat, nbf, exp: iat + 300, jti }
 *
 * `sub` is pairwise: the same reader has a different, stable `sub` for each plugin, so two backends can't join their
 * users by it, and it survives a change of handle. `handle` is the reader's public handle, which the approval prompt
 * says the plugin learns. A plugin loaded from localhost gets `aud: "dev:<plugin id>"` and `dev: true`, so its token is
 * refused by the published plugin's backend: anyone can claim any id on their own machine.
 */

export const IDENTITY_ALG = 'ES256';
/** How long a token is good for. */
export const IDENTITY_TOKEN_SECONDS = 300;
/** Where backends find the keys. */
export const JWKS_PATH = '/.well-known/jwks.json';

export interface IdentityClaims {
  iss: string;
  aud: string;
  sub: string;
  handle: string;
  plugin: string;
  dev?: true;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export interface IdentityToken {
  token: string;
  /** ISO time it stops verifying. */
  expiresAt: string;
  audience: string;
  issuer: string;
  /** The reader's pairwise subject for this plugin, as `sub` holds it. */
  subject: string;
  handle: string;
  /** Where the keys are. */
  jwksUrl: string;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** The issuer: the site's origin. */
export function identityIssuer(): string {
  return new URL(siteUrl()).origin;
}

/** A token's audience: the plugin's id, or `dev:<id>` for one loaded from localhost. */
export function identityAudience(pluginId: string, dev = false): string {
  return dev ? `dev:${pluginId}` : pluginId;
}

function subjectSecret(): string {
  const secret = process.env.PLUGIN_SUBJECT_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('PLUGIN_SUBJECT_SECRET (or BETTER_AUTH_SECRET) must be set to give plugins identities');
  return secret;
}

/**
 * The reader's subject for one plugin: stable, and different per plugin. Changing `PLUGIN_SUBJECT_SECRET` (or, without
 * it, `BETTER_AUTH_SECRET`) changes every subject.
 */
export function pluginSubject(accountId: string, pluginId: string): string {
  const mac = createHmac('sha256', subjectSecret()).update(`plugin-subject\0${accountId}\0${pluginId}`).digest();
  return `p_${mac.subarray(0, 16).toString('base64url')}`;
}

/** RFC 7638 thumbprint of an EC public key: what we name it by (`kid`). */
function thumbprint(jwk: Record<string, string>): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64url(createHash('sha256').update(canonical).digest());
}

function newKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  return { kid: thumbprint(publicJwk), privateJwk, publicJwk };
}

/** Adds a new signing key, which signs from now on; the others stay published until retired. Its `kid`. */
export async function rotateIdentityKey(database: Database = getDb()): Promise<string> {
  const key = newKeyPair();
  await database.insert(identityKeys).values({ ...key, alg: IDENTITY_ALG });
  cached = null;
  return key.kid;
}

/** Stops publishing a key: tokens it signed stop verifying. Refuses the last one. */
export async function retireIdentityKey(kid: string, database: Database = getDb()): Promise<void> {
  const live = await database
    .select({ kid: identityKeys.kid })
    .from(identityKeys)
    .where(isNull(identityKeys.retiredAt));
  if (!live.some((k) => k.kid === kid)) throw new Error(`no published key ${kid}`);
  if (live.length === 1) throw new Error(`${kid} is the only key; rotate first`);
  await database.update(identityKeys).set({ retiredAt: new Date() }).where(eq(identityKeys.kid, kid));
  cached = null;
}

export async function listIdentityKeys(database: Database = getDb()) {
  return database
    .select({
      kid: identityKeys.kid,
      alg: identityKeys.alg,
      createdAt: identityKeys.createdAt,
      retiredAt: identityKeys.retiredAt,
    })
    .from(identityKeys)
    .orderBy(desc(identityKeys.createdAt));
}

let cached: { at: number; kid: string; key: KeyObject } | null = null;
const KEY_CACHE_MS = 60_000;

/** The key that signs: the newest unretired one, made on first use. */
async function signingKey(database: Database): Promise<{ kid: string; key: KeyObject }> {
  if (cached && Date.now() - cached.at < KEY_CACHE_MS) return cached;
  const newest = () =>
    database
      .select()
      .from(identityKeys)
      .where(isNull(identityKeys.retiredAt))
      .orderBy(desc(identityKeys.createdAt), desc(identityKeys.kid))
      .limit(1);
  let [row] = await newest();
  if (!row) {
    await rotateIdentityKey(database);
    [row] = await newest();
  }
  cached = { at: Date.now(), kid: row.kid, key: createPrivateKey({ key: row.privateJwk, format: 'jwk' }) };
  return cached;
}

/** The published keys, as `/.well-known/jwks.json` serves them. */
export async function identityJwks(
  database: Database = getDb(),
): Promise<{ keys: (Record<string, string> & { kid: string; alg: string; use: 'sig' })[] }> {
  let rows = await database
    .select()
    .from(identityKeys)
    .where(isNull(identityKeys.retiredAt))
    .orderBy(desc(identityKeys.createdAt));
  if (rows.length === 0) {
    await signingKey(database);
    rows = await database.select().from(identityKeys).where(isNull(identityKeys.retiredAt));
  }
  return { keys: rows.map((r) => ({ ...r.publicJwk, kid: r.kid, alg: r.alg, use: 'sig' as const })) };
}

/** Forget the cached signing key (tests reset the database under it). */
export function forgetIdentityKey() {
  cached = null;
}

/** Sign a token for a reader and a plugin. Doesn't check that the plugin may have one: `identityTokenFor` does. */
export async function signIdentityToken(
  account: Pick<Account, 'id' | 'handle'>,
  pluginId: string,
  options: { dev?: boolean; now?: number; database?: Database } = {},
): Promise<IdentityToken> {
  const { dev = false, database = getDb() } = options;
  const { kid, key } = await signingKey(database);
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const claims: IdentityClaims = {
    iss: identityIssuer(),
    aud: identityAudience(pluginId, dev),
    sub: pluginSubject(account.id, pluginId),
    handle: account.handle,
    plugin: pluginId,
    ...(dev ? { dev: true as const } : {}),
    iat,
    nbf: iat - 30,
    exp: iat + IDENTITY_TOKEN_SECONDS,
    jti: randomUUID(),
  };
  const input = `${b64url(JSON.stringify({ alg: IDENTITY_ALG, typ: 'JWT', kid }))}.${b64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return {
    token: `${input}.${b64url(signature)}`,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
    audience: claims.aud,
    issuer: claims.iss,
    subject: claims.sub,
    handle: claims.handle,
    jwksUrl: `${claims.iss}${JWKS_PATH}`,
  };
}

/**
 * A token for the signed-in reader and one of their plugins, if that plugin may have one: installed, enabled, running,
 * and with `identity` approved by the reader (a site default too: only the reader can give it). A plugin loaded from
 * localhost (`dev`) gets one for its `dev:` audience, which no published backend accepts.
 */
export async function identityTokenFor(
  account: Account,
  input: { plugin: string; dev?: boolean },
  database: Database = getDb(),
): Promise<IdentityToken> {
  if (!PLUGIN_ID_RE.test(input.plugin)) throw new ApiError(422, 'validation_error', 'not a plugin id');
  if (input.dev) return signIdentityToken(account, input.plugin, { dev: true, database });
  const plugin = (await installedPlugins(account, { fetch: false, database })).find(
    (p) => p.plugin?.id === input.plugin,
  );
  if (!plugin?.plugin) throw new ApiError(404, 'not_found', `${input.plugin} isn't installed`);
  if (plugin.status !== 'ready') {
    throw new ApiError(403, 'forbidden', `${input.plugin} isn't running (${plugin.status})`);
  }
  if (!plugin.plugin.manifest.permissions.includes('identity')) {
    throw new ApiError(403, 'forbidden', `${input.plugin} doesn't ask for the "identity" permission`);
  }
  if (!runningPermissions({ ...plugin, plugin: plugin.plugin }).includes('identity')) {
    throw new ApiError(403, 'forbidden', `you haven't approved "identity" for ${input.plugin}`);
  }
  return signIdentityToken(account, input.plugin, { database });
}
