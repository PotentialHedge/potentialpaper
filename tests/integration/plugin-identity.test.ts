import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as jwksRoute } from '@/app/.well-known/jwks.json/route';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import {
  IDENTITY_TOKEN_SECONDS,
  pluginSubject,
  retireIdentityKey,
  rotateIdentityKey,
  signIdentityToken,
} from '@/server/plugins/identity';
import { pinPlugin, storePluginFiles } from '@/server/plugins/snapshot';
import { saveSiteSettings } from '@/server/settings';
import { mintToken } from '@/server/tokens';
// The example backend's own verifier: what the guide tells a plugin's backend to do, run against the site's tokens.
import { identityVerifier, verifyIdentityToken } from '../../examples/plugins/notes-backend/verify.mjs';
import { api, closePool, resetDatabase, signUp } from './helpers';

/**
 * Plugins with their own backend (`handoffs/plugins.md` Phase 5): the `identity` permission's tokens, the keys at
 * `/.well-known/jwks.json`, consent for identity even from a site default, and a manifest's `bot`. The plugin is the
 * example `examples/plugins/notes`, and its backend's `verify.mjs` checks the tokens.
 */

const DIR = 'examples/plugins/notes';
const OWNER = 'potentialhedge';
const REPO = 'potentialpaper';
const SOURCE = `github:${OWNER}/${REPO}/${DIR}`;
const PLUGIN = 'potentialhedge/notes';
const V1 = '1'.repeat(40);
const ISSUER = 'http://test.local';

async function storeNotes(edit: (manifest: Record<string, unknown>) => void = () => {}) {
  const source = { kind: 'github' as const, owner: OWNER, repo: REPO, path: DIR, ref: null };
  const files = readdirSync(DIR).map((path) => {
    let text = readFileSync(join(DIR, path), 'utf8');
    if (path === 'potentialpaper-plugin.json') {
      const manifest = JSON.parse(text);
      edit(manifest);
      text = JSON.stringify(manifest);
    }
    return { path, bytes: Buffer.from(text) };
  });
  await storePluginFiles(source, V1, files);
  await pinPlugin(SOURCE, 'v1', V1);
}

async function install(cookie: string) {
  await api('PUT', '/me/settings', {
    cookie,
    text: `{ "plugins": { "${SOURCE}": { "enabled": true, "ref": "v1" } } }`,
  });
}

const jwks = async () => (await jwksRoute()).json();
const installed = async (cookie?: string) => (await api('GET', '/plugins/installed', { cookie })).body;
const token = (cookie: string, body: Record<string, unknown> = { plugin: PLUGIN }) =>
  api('POST', '/me/plugins/identity', { cookie, body });

let store: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), 'plugin-store-'));
  process.env.DEMOS_DIR = store;
});
afterAll(async () => {
  rmSync(store, { recursive: true, force: true });
  await closePool();
});
beforeEach(resetDatabase);

describe('identity tokens', () => {
  it("signs a token for an approved plugin that its backend verifies, and that no other plugin's accepts", async () => {
    await storeNotes();
    const cookie = await signUp('ada@ethz.ch');
    await install(cookie);
    expect((await installed(cookie)).plugins[0]).toMatchObject({
      status: 'consent',
      missing: { permissions: ['identity'], network: ['https://notes.potentialpaper.example'] },
    });
    // Not approved yet: no token.
    expect(await token(cookie)).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    await api('PUT', '/me/plugins/grants', { cookie, body: { plugin: PLUGIN, commit: V1 } });

    const res = await token(cookie);
    expect(res.status).toBe(200);
    const [account] = await getDb().select().from(accounts);
    expect(res.body).toMatchObject({
      audience: PLUGIN,
      issuer: ISSUER,
      handle: account.handle,
      subject: pluginSubject(account.id, PLUGIN),
      jwksUrl: `${ISSUER}/.well-known/jwks.json`,
    });
    const keys = await jwks();
    expect(keys.keys).toEqual([expect.objectContaining({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' })]);
    expect(keys.keys[0].d).toBeUndefined();

    const claims = verifyIdentityToken(res.body.token, { jwks: keys, issuer: ISSUER, audience: PLUGIN });
    expect(claims).toMatchObject({ iss: ISSUER, aud: PLUGIN, plugin: PLUGIN, handle: account.handle });
    expect(claims.exp - claims.iat).toBe(IDENTITY_TOKEN_SECONDS);
    expect(Date.parse(res.body.expiresAt)).toBe(claims.exp * 1000);
    expect(claims.sub).toMatch(/^p_[A-Za-z0-9_-]{22}$/);
    expect(claims.sub).not.toContain(account.id);

    // The same reader has the same subject for this plugin every time, and another for every other plugin.
    const again = verifyIdentityToken((await token(cookie)).body.token, {
      jwks: keys,
      issuer: ISSUER,
      audience: PLUGIN,
    });
    expect(again.sub).toBe(claims.sub);
    expect(again.jti).not.toBe(claims.jti);
    expect(pluginSubject(account.id, 'someone/else')).not.toBe(claims.sub);

    // Another plugin's backend, another site, a changed token, an old one: refused.
    const t = res.body.token;
    expect(() => verifyIdentityToken(t, { jwks: keys, issuer: ISSUER, audience: 'someone/else' })).toThrow(/meant for/);
    expect(() => verifyIdentityToken(t, { jwks: keys, issuer: 'https://evil.example', audience: PLUGIN })).toThrow(
      /issued by/,
    );
    const [h, p, s] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), handle: 'admin' }),
    ).toString('base64url');
    expect(() => verifyIdentityToken(`${h}.${forged}.${s}`, { jwks: keys, issuer: ISSUER, audience: PLUGIN })).toThrow(
      /signature/,
    );
    const later = Date.now() + (IDENTITY_TOKEN_SECONDS + 120) * 1000;
    expect(() => verifyIdentityToken(t, { jwks: keys, issuer: ISSUER, audience: PLUGIN, now: later })).toThrow(
      /expired/,
    );
  });

  it('needs a browser session, a plugin that asks for it, and gives localhost plugins a dev audience', async () => {
    await storeNotes((m) => {
      m.permissions = [];
    });
    const cookie = await signUp('ada@ethz.ch');
    await install(cookie);
    await api('PUT', '/me/plugins/grants', { cookie, body: { plugin: PLUGIN, commit: V1 } });
    expect(await token(cookie)).toMatchObject({
      status: 403,
      body: { error: { message: expect.stringContaining("doesn't ask for") } },
    });
    expect(await token(cookie, { plugin: 'nobody/here' })).toMatchObject({ status: 404 });
    expect((await api('POST', '/me/plugins/identity', { body: { plugin: PLUGIN } })).status).toBe(401);

    // An agent acting for the reader can't get one: the frame's host asks for it, in the browser.
    const [account] = await getDb().select().from(accounts);
    const agent = await mintToken({ account, name: 'agent', scopes: ['write'] });
    expect((await api('POST', '/me/plugins/identity', { token: agent.token, body: { plugin: PLUGIN } })).status).toBe(
      403,
    );

    // A plugin loaded from localhost may claim any id, so its token is for `dev:<id>`, which the real backend refuses.
    const dev = await token(cookie, { plugin: 'someone/else', dev: true });
    expect(dev.body).toMatchObject({ audience: 'dev:someone/else' });
    const keys = await jwks();
    expect(() => verifyIdentityToken(dev.body.token, { jwks: keys, issuer: ISSUER, audience: 'someone/else' })).toThrow(
      /meant for/,
    );
    expect(
      verifyIdentityToken(dev.body.token, { jwks: keys, issuer: ISSUER, audience: 'dev:someone/else' }),
    ).toMatchObject({ dev: true });
  });

  it('asks every reader for identity, even when the site installs the plugin for everyone', async () => {
    await storeNotes();
    await saveSiteSettings(`{ "plugins.default": ["${SOURCE}@v1"] }`);
    const cookie = await signUp('ada@ethz.ch');
    // It runs, as a default does, but without identity until the reader gives it.
    expect((await installed(cookie)).plugins[0]).toMatchObject({
      from: 'site',
      status: 'ready',
      missing: { permissions: ['identity'], network: [] },
    });
    expect(await token(cookie)).toMatchObject({
      status: 403,
      body: { error: { message: expect.stringContaining('approved "identity"') } },
    });
    await api('PUT', '/me/plugins/grants', { cookie, body: { plugin: PLUGIN, commit: V1 } });
    expect((await installed(cookie)).plugins[0]).toMatchObject({ status: 'ready', missing: { permissions: [] } });
    expect((await token(cookie)).status).toBe(200);
    // Signed out, the default runs and nothing is missing that a reader could give.
    expect((await installed()).plugins[0]).toMatchObject({ status: 'ready', missing: { permissions: ['identity'] } });
  });
});

describe('the signing keys', () => {
  it('publishes every live key, so tokens verify across a rotation, until the old key is retired', async () => {
    await signUp('ada@ethz.ch');
    const [account] = await getDb().select().from(accounts);
    const before = await signIdentityToken(account, PLUGIN);
    const first = (await jwks()).keys[0].kid;

    // The backend fetches the keys once, and again when a token names a key it doesn't know.
    let fetched = 0;
    const verifier = identityVerifier({
      site: ISSUER,
      plugin: PLUGIN,
      minRefetchMs: 0,
      fetchJwks: async () => {
        fetched += 1;
        return jwks();
      },
    });
    expect((await verifier.verify(before.token)).sub).toBe(before.subject);
    expect(fetched).toBe(1);

    const second = await rotateIdentityKey();
    const after = await signIdentityToken(account, PLUGIN);
    expect(JSON.parse(Buffer.from(after.token.split('.')[0], 'base64url').toString()).kid).toBe(second);
    expect((await jwks()).keys.map((k: { kid: string }) => k.kid).sort()).toEqual([first, second].sort());
    expect((await verifier.verify(after.token)).sub).toBe(after.subject);
    expect(fetched).toBe(2);
    expect((await verifier.verify(before.token)).sub).toBe(before.subject);

    await retireIdentityKey(first);
    await expect(retireIdentityKey(second)).rejects.toThrow(/only key/);
    expect(() => verifyIdentityToken(before.token, { jwks: { keys: [] }, issuer: ISSUER, audience: PLUGIN })).toThrow(
      /unknown key/,
    );
    const live = await jwks();
    expect(live.keys.map((k: { kid: string }) => k.kid)).toEqual([second]);
    expect(() => verifyIdentityToken(before.token, { jwks: live, issuer: ISSUER, audience: PLUGIN })).toThrow(
      /unknown key/,
    );
  });
});

describe("a plugin's bot", () => {
  it('lists the bot a manifest names with what this site lets it write, or says there is none', async () => {
    await ensureBot(OPENREVIEW_BOT);
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await storeNotes((m) => {
      m.bot = OPENREVIEW_BOT;
    });
    const cookie = await signUp('ada@ethz.ch');
    await install(cookie);
    expect((await installed(cookie)).plugins[0].plugin.bot).toEqual({
      handle: OPENREVIEW_BOT,
      known: true,
      grants: [{ kind: 'paper', pattern: 'reviews/openreview/**' }],
    });

    // A person's handle is no bot.
    const [person] = await getDb().select().from(accounts).where(eq(accounts.isBot, false));
    await getDb().execute(sql`truncate table plugin_refs, plugin_snapshots`);
    await storeNotes((m) => {
      m.bot = person.handle;
    });
    expect((await installed(cookie)).plugins[0].plugin.bot).toEqual({
      handle: person.handle,
      known: false,
      grants: [],
    });
  });
});
