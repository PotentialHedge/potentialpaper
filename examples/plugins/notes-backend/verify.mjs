// Verifying a potentialpaper identity token, with nothing but Node's own crypto (Node 18+). Copy this file into your
// backend, or use any JWT library that does ES256 and JWKS (jose, PyJWT, …): it checks the same things.
//
//   const verifier = identityVerifier({ site: 'https://potentialpaper.org', plugin: '<owner>/<name>' });
//   const claims = await verifier.verify(token); // throws if the token isn't good for this plugin, now
//   claims.sub;    // the reader, stable, and different for every plugin: key your data by it
//   claims.handle; // their handle, for showing
import { createPublicKey, verify } from 'node:crypto';

/** Clocks differ a little: accept tokens this many seconds either side of their window. */
const LEEWAY_SECONDS = 60;

function part(text) {
  return JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
}

/**
 * Check a token against a JWKS (`{ keys: [...] }`), for one issuer (the site's origin) and one audience (your plugin's
 * id). Returns its claims, or throws saying what is wrong.
 */
export function verifyIdentityToken(token, { jwks, issuer, audience, now = Date.now() }) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new Error('not a JWT');
  const header = part(parts[0]);
  if (header.alg !== 'ES256') throw new Error(`unexpected alg ${header.alg}`);
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw Object.assign(new Error(`unknown key ${header.kid}`), { unknownKey: true });
  const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
  const ok = verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) throw new Error('bad signature');
  const claims = part(parts[1]);
  if (claims.iss !== issuer) throw new Error(`issued by ${claims.iss}, not ${issuer}`);
  if (claims.aud !== audience) throw new Error(`meant for ${claims.aud}, not ${audience}`);
  const seconds = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + LEEWAY_SECONDS < seconds) throw new Error('expired');
  if (typeof claims.nbf === 'number' && claims.nbf - LEEWAY_SECONDS > seconds) throw new Error('not valid yet');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('no subject');
  return claims;
}

/**
 * A verifier for one site and plugin that fetches the site's keys (`/.well-known/jwks.json`) and keeps them. A token
 * naming a key it doesn't have (the site rotated its keys) fetches them again: once per unknown key a minute, and never
 * more often than `minRefetchMs`, so made-up key ids can't send every request to the site.
 */
export function identityVerifier({ site, plugin, dev = false, fetchJwks = defaultFetch, minRefetchMs = 1000 }) {
  const issuer = new URL(site).origin;
  const audience = dev ? `dev:${plugin}` : plugin;
  let jwks = null;
  let fetchedAt = 0;
  const tried = new Map();
  async function load() {
    jwks = await fetchJwks(`${issuer}/.well-known/jwks.json`);
    fetchedAt = Date.now();
    return jwks;
  }
  return {
    issuer,
    audience,
    async verify(token) {
      try {
        return verifyIdentityToken(token, { jwks: jwks ?? (await load()), issuer, audience });
      } catch (e) {
        if (!e.unknownKey) throw e;
        const kid = e.message.slice('unknown key '.length);
        const now = Date.now();
        if (now - (tried.get(kid) ?? 0) < 60_000 || now - fetchedAt < minRefetchMs) throw e;
        if (tried.size > 100) tried.clear();
        tried.set(kid, now);
        return verifyIdentityToken(token, { jwks: await load(), issuer, audience });
      }
    },
  };
}

async function defaultFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
