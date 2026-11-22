import 'dotenv/config';
import { getPool } from '@/db';
import { KEYED_KINDS, keyedPagePath, KINDS } from '@/lib/kinds';
import { createPage } from '@/server/pages/commit';
import { siteUrl } from '@/server/site';

const USAGE = `Makes a page of a kind other than a paper (handoffs/pages.md), with its repo started, or says where the
one there is lives. Admins only, on the server; each kind gets its own way to be made with its phase (the venues
bot, sign-up, the "New category" form). What the page says is then written by clone and push, under its path rules.

  npm run pages:create -- venue iclr/2027
  npm run pages:create -- category linear-attention
  npm run pages:create -- org eth/inf
  npm run pages:create -- user <handle>`;

async function main() {
  const [kind, key, ...rest] = process.argv.slice(2);
  const keyed = KEYED_KINDS.find((k) => k === kind);
  if (!keyed || !key || rest.length > 0) {
    console.log(USAGE);
    return;
  }
  const page = await createPage(keyed, key);
  console.log(
    `${KINDS[keyed].title} page ${keyed}:${key}: ${siteUrl()}${keyedPagePath(keyed, key)} (head ${page.head})`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
