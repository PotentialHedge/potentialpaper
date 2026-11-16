import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { ensureBot, grantBot, listGrants, revokeGrant } from '@/server/bots';

const USAGE = `Grants a bot write access to a path pattern (DESIGN.md §10, "Bots"). Admins only, on the server.

  npm run bots:grant                                            # lists every grant
  npm run bots:grant -- <handle> 'reviews/<source>/**' --by <admin handle> [--hidden] [--create]
  npm run bots:grant -- <handle> 'reviews/<source>/**' --revoke

--create makes the bot account if there is none. --hidden: what it writes isn't shown to everyone by default.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      by: { type: 'string' },
      hidden: { type: 'boolean' },
      create: { type: 'boolean' },
      revoke: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length === 1 || positionals.length > 2) {
    console.log(USAGE);
    return;
  }
  if (positionals.length === 0) {
    const grants = await listGrants();
    if (grants.length === 0) console.log('No grants.');
    for (const g of grants) {
      console.log(
        `${g.handle}\t${g.pattern}\t${g.shown ? 'shown' : 'hidden'}\tby ${g.grantedBy}, ${g.createdAt.toISOString()}`,
      );
    }
    return;
  }
  const [handle, pattern] = positionals;
  if (values.revoke) {
    console.log((await revokeGrant(handle, pattern)) ? `${handle}: ${pattern} revoked` : `${handle} had no ${pattern}`);
    return;
  }
  if (!values.by) throw new Error('say who grants it: --by <admin handle>');
  if (values.create) await ensureBot(handle);
  await grantBot(handle, pattern, { grantedBy: values.by, shown: !values.hidden });
  console.log(`${handle}: granted ${pattern}${values.hidden ? ' (hidden by default)' : ''}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
