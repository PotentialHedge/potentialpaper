import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts, user } from '@/db/schema';
import { parsePaperId, PAPER_SCHEMES, type PaperScheme } from '@/lib/paper-ids';
import { isAdminEmail } from '@/server/auth';
import { removeThumbnail, setThumbnail } from '@/server/pages/card';
import type { Actor } from '@/server/pages/commit';
import { refreshPaperPages } from '@/server/pages/refresh';
import { MAX_THUMBNAIL_BYTES } from '@/server/pages/rules';
import { findPaper } from '@/server/papers';

const USAGE = `Set a paper's thumbnail, shown in place of its PDF's first page. The paper's edit page does the same.

  npm run pages:set-thumbnail -- openreview:j6wn1MIOB5 ./teaser.gif --as <admin handle> [--alt "..."] [--caption "..."]
  npm run pages:set-thumbnail -- openreview:j6wn1MIOB5 --remove --as <admin handle>

JPEG, PNG, GIF (animated too), WebP or AVIF, up to ${MAX_THUMBNAIL_BYTES / 1024 / 1024} MB. The bytes go to R2
under their SHA-256 (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY), and the page's
thumbnail.<ext> (a Git LFS pointer) names them. Without R2 keys, in development, they go to public/thumbnails (or THUMBNAILS_DIR).`;

async function adminActor(handle: string): Promise<Actor> {
  const [row] = await getDb()
    .select({ id: accounts.id, email: user.email })
    .from(accounts)
    .leftJoin(user, eq(user.id, accounts.userId))
    .where(eq(accounts.handle, handle.toLowerCase()));
  if (!row) throw new Error(`no account with the handle ${handle}`);
  return { kind: 'account', accountId: row.id, isAdmin: row.email ? isAdminEmail(row.email) : false };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      as: { type: 'string' },
      alt: { type: 'string' },
      caption: { type: 'string' },
      remove: { type: 'boolean' },
    },
  });
  const [target, file] = positionals;
  const [schemeText, ...rest] = (target ?? '').split(':');
  const scheme = PAPER_SCHEMES.find((s): s is PaperScheme => s === schemeText);
  const id = scheme && parsePaperId(scheme, rest.join(':'));
  if (!id || !values.as || (!file && !values.remove)) {
    console.error(USAGE);
    process.exit(2);
  }
  const found = await findPaper(id);
  if (!found) throw new Error(`no paper ${target} in this database`);
  const actor = await adminActor(values.as);
  const paperId = found.paper.id;

  const result = values.remove
    ? await removeThumbnail(paperId, actor)
    : await setThumbnail(paperId, actor, { image: readFileSync(file!), alt: values.alt, caption: values.caption });
  await refreshPaperPages(found.identifiers);
  console.log(JSON.stringify(result));
  await getPool().end();
}

main().catch((err) => {
  console.error(err.message ?? err, err.details ? JSON.stringify(err.details, null, 2) : '');
  process.exit(1);
});
