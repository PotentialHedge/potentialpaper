import 'dotenv/config';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts, paperIdentifiers } from '@/db/schema';
import { decideClaim, pendingClaims } from '@/server/claims';
import { refreshPaperPages } from '@/server/pages/refresh';

const USAGE = `List claims of authorship waiting for a decision, or decide one. How claims should be verified is
still open (DESIGN.md §6), so for now an admin reads the evidence and decides here.

  npm run claims:decide                                  # list pending claims
  npm run claims:decide -- --confirm <claim id> --as <admin handle>
  npm run claims:decide -- --reject <claim id> --as <admin handle>`;

async function main() {
  const { values } = parseArgs({
    options: { confirm: { type: 'string' }, reject: { type: 'string' }, as: { type: 'string' } },
  });
  const claimId = values.confirm ?? values.reject;
  if (!claimId) {
    const rows = await pendingClaims();
    if (rows.length === 0) console.log('No claims are waiting.');
    for (const row of rows) {
      console.log(
        [
          `${row.id}  ${row.createdAt.toISOString().slice(0, 16)}`,
          `  paper:   ${row.title}`,
          `  as:      ${row.authorName}`,
          `  account: @${row.handle}${row.realName ? ` (${row.realName})` : ''}, ${row.institutions.join('; ') || 'no institution'}`,
          `  says:    ${row.evidence.replace(/\s+/g, ' ') || '(nothing)'}`,
          '',
        ].join('\n'),
      );
    }
    await getPool().end();
    return;
  }
  if (!values.as || (values.confirm && values.reject)) {
    console.error(USAGE);
    process.exit(2);
  }
  const [admin] = await getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.handle, values.as.toLowerCase()));
  if (!admin) throw new Error(`no account with the handle ${values.as}`);
  const claim = await decideClaim(claimId, values.confirm ? 'confirmed' : 'rejected', admin.id);
  const identifiers = await getDb()
    .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, claim.paperId));
  await refreshPaperPages(identifiers);
  console.log(`${claim.status}: ${claim.authorName}`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
