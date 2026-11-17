import 'dotenv/config';
import { getDb, getPool } from '@/db';
import { PROTECTION_LEVELS } from '@/db/schema';
import { isProtectionLevel, protectionOf, protectionWords, setProtection } from '@/server/page-protection';
import { findPage } from '@/server/pages/kinds';
import { refreshPageIds } from '@/server/pages/refresh';

const USAGE = `Sets, shows or lifts a page's protection (DESIGN.md §7, server/page-protection.ts). Admins only, on the
server; the same as PUT /api/v1/pages/{identifier}/protection.

  npm run pages:protect -- topic:linear-attention                       show it
  npm run pages:protect -- topic:linear-attention established [--reason "Edit war"] [--days 7]
  npm run pages:protect -- topic:linear-attention admins
  npm run pages:protect -- topic:linear-attention none                  lift it

Levels: ${PROTECTION_LEVELS.join(', ')}. established: accounts verified for a few days; admins: admins only. Owners
(a paper's authors, a venue's organisers, an org's members) keep their own part, and bots their grants.`;

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const reason = flag(args, '--reason');
  const days = flag(args, '--days');
  const [identifier, level, ...rest] = args;
  if (!identifier || rest.length > 0 || (level && level !== 'none' && !isProtectionLevel(level))) {
    console.log(USAGE);
    return;
  }
  const page = await findPage(identifier);
  if (!page) throw new Error(`no page is ${identifier}`);
  if (level) {
    const expiresAt = days ? new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000) : null;
    await setProtection(
      page,
      { level: level === 'none' ? null : (level as (typeof PROTECTION_LEVELS)[number]), reason, expiresAt },
      { kind: 'system' },
    );
    await refreshPageIds(getDb(), [page.id]);
  }
  const protection = await protectionOf(getDb(), page.id);
  console.log(
    protection
      ? `${identifier} is protected: ${protectionWords(protection.level)}${protection.reason ? ` (${protection.reason})` : ''}${
          protection.expiresAt ? `, until ${protection.expiresAt.toISOString()}` : ''
        }`
      : `${identifier} is not protected`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
