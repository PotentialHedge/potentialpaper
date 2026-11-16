import 'dotenv/config';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts, paperIdentifiers } from '@/db/schema';
import { decideClaim, pendingClaims } from '@/server/claims';
import { decidePageClaim, isPageClaim, pendingPageClaims } from '@/server/page-claims';
import { refreshPaperPages } from '@/server/pages/refresh';

const USAGE = `List claims waiting for a decision, or decide one. Two kinds wait here:

- claims of authorship: one from an account with a confirmed address on the paper's first page is confirmed on its
  own (method 'email'); the rest wait for an admin to read the evidence and decide (method 'manual', DESIGN.md §6);
- claims to organise a venue (handoffs/pages.md Phase 2): every one waits for an admin. A series' organisers also
  organise its editions.

  npm run claims:decide                                  # list pending claims
  npm run claims:decide -- --confirm <claim id> --as <admin handle>
  npm run claims:decide -- --reject <claim id> --as <admin handle>`;

async function list() {
  const [authors, organisers] = await Promise.all([pendingClaims(), pendingPageClaims()]);
  if (authors.length + organisers.length === 0) console.log('No claims are waiting.');
  for (const row of authors) {
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
  for (const row of organisers) {
    console.log(
      [
        `${row.id}  ${row.createdAt.toISOString().slice(0, 16)}`,
        `  organise: ${row.identifier}`,
        `  account:  @${row.handle}${row.realName ? ` (${row.realName})` : ''}, ${row.institutions.join('; ') || 'no institution'}`,
        `  says:     ${row.evidence.replace(/\s+/g, ' ') || '(nothing)'}`,
        '',
      ].join('\n'),
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: { confirm: { type: 'string' }, reject: { type: 'string' }, as: { type: 'string' } },
  });
  const claimId = values.confirm ?? values.reject;
  if (!claimId) {
    await list();
    return;
  }
  if (!values.as || (values.confirm && values.reject)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const [admin] = await getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.handle, values.as.toLowerCase()));
  if (!admin) throw new Error(`no account with the handle ${values.as}`);
  const status = values.confirm ? 'confirmed' : 'rejected';
  if (await isPageClaim(claimId)) {
    const claim = await decidePageClaim(claimId, status, admin.id);
    console.log(`${claim.status}: organiser of ${claim.identifier}`);
    return;
  }
  const claim = await decideClaim(claimId, status, admin.id);
  const identifiers = await getDb()
    .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, claim.paperId));
  await refreshPaperPages(identifiers);
  console.log(`${claim.status}: ${claim.authorName}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
