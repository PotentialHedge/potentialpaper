import 'dotenv/config';
import { getPool } from '@/db';
import { identityJwks, listIdentityKeys, retireIdentityKey, rotateIdentityKey } from '@/server/plugins/identity';

const USAGE = `The keys that sign plugins' identity tokens (server/plugins/identity.ts), published at /.well-known/jwks.json.

  npm run identity:keys                 list them (the first is made on first use)
  npm run identity:keys -- rotate       add a new key, which signs from now on; the others stay published
  npm run identity:keys -- retire <kid> stop publishing a key: tokens it signed stop verifying

Rotate, wait past the JWKS cache (5 minutes) and the tokens' life (5 minutes), then retire the old key.`;

async function main() {
  const [command, kid, ...rest] = process.argv.slice(2);
  if (
    rest.length > 0 ||
    (command && !['rotate', 'retire', 'list'].includes(command)) ||
    (command === 'retire' && !kid)
  ) {
    console.log(USAGE);
    return;
  }
  if (command === 'rotate') console.log(`new signing key ${await rotateIdentityKey()}`);
  if (command === 'retire') {
    await retireIdentityKey(kid);
    console.log(`retired ${kid}`);
  }
  if (!command || command === 'list') await identityJwks();
  for (const key of await listIdentityKeys()) {
    const state = key.retiredAt ? `retired ${key.retiredAt.toISOString()}` : 'published';
    console.log(`${key.kid}  ${key.alg}  made ${key.createdAt.toISOString()}  ${state}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
