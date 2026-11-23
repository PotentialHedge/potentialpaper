import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { listBotLimits, setBotLimit } from '@/server/bots';
import { rateLimitConfig } from '@/server/ratelimit';

const USAGE = `Sets a bot's own request limit, so an outside publisher's bot can be kept slower than our importers. Without
one a bot has the trusted bucket (API_RATE_LIMIT_TRUSTED_*). Admins only, on the server.

  npm run bots:limit                                              # lists the bots and their limits
  npm run bots:limit -- <handle> --per-second 50 --burst 500
  npm run bots:limit -- <handle> --clear                          # back to the trusted bucket`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'per-second': { type: 'string' },
      burst: { type: 'string' },
      clear: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || positionals.length > 1) {
    console.log(USAGE);
    return;
  }
  if (positionals.length === 0) {
    const trusted = rateLimitConfig(true);
    const bots = await listBotLimits();
    if (bots.length === 0) console.log('No bots.');
    for (const bot of bots) {
      const own = bot.perSecond !== null && bot.burst !== null;
      const { perSecond, burst } = own ? { perSecond: bot.perSecond, burst: bot.burst } : trusted;
      console.log(`${bot.handle}\t${perSecond}/s, bursts of ${burst}${own ? '' : ' (trusted default)'}`);
    }
    return;
  }
  const [handle] = positionals;
  if (values.clear) {
    if (!(await setBotLimit(handle, null))) throw new Error(`no bot called ${handle}`);
    console.log(`${handle}: back to the trusted bucket`);
    return;
  }
  const perSecond = Number(values['per-second']);
  const burst = Number(values.burst);
  if (values['per-second'] === undefined || values.burst === undefined) {
    throw new Error('give both --per-second and --burst, or --clear');
  }
  if (!(await setBotLimit(handle, { perSecond, burst }))) throw new Error(`no bot called ${handle}`);
  console.log(`${handle}: ${perSecond}/s, bursts of ${burst}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
