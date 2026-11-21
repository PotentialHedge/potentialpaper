import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts } from '@/db/schema';
import { mintToken } from '@/server/tokens';

const USAGE = `Makes an API token for a bot, for an import tool to call /api/v1/imports/* with. Admins only, on the server.
The token is printed once; keep it in the tool's secrets. Revoke it as any token, by its id.

  npm run bots:token -- <handle> [name]`;

async function main() {
  const [handle, name = 'import tool'] = process.argv.slice(2);
  if (!handle) {
    console.error(USAGE);
    process.exit(2);
  }
  const [account] = await getDb().select().from(accounts).where(eq(accounts.handle, handle));
  if (!account?.isBot) throw new Error(`${handle} is not a bot (npm run bots:grant -- ${handle} … --create)`);
  const minted = await mintToken({ account, name, scopes: ['read', 'write'] });
  console.log(`token ${minted.id} for ${handle}:\n${minted.token}`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
