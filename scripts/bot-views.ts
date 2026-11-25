import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { pullBotViews } from '@/server/bot-views';

const USAGE = `Pulls bots' and crawlers' reads of each page from Cloudflare into its analytics (src/server/bot-views.ts),
replacing what those days had. Run daily; Cloudflare keeps 31 days. Needs CLOUDFLARE_ANALYTICS_TOKEN (Zone Analytics
Read on the site's zone) and CLOUDFLARE_ZONE_ID.

  npm run analytics:bots                 # today and the 2 days before it
  npm run analytics:bots -- --days 31    # the last 31 days`;

async function main() {
  const { values } = parseArgs({
    options: { days: { type: 'string', default: '3' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zone) throw new Error('set CLOUDFLARE_ANALYTICS_TOKEN and CLOUDFLARE_ZONE_ID');
  const days = Math.min(31, Math.max(1, Number(values.days) || 3));
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  for (let back = days - 1; back >= 0; back -= 1) {
    const day = new Date(today - back * 86_400_000).toISOString().slice(0, 10);
    const { requests, pages } = await pullBotViews(day, { token, zone });
    console.log(`${day}: ${requests} bot reads on ${pages} pages`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
