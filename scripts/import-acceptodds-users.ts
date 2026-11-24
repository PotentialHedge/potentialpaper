import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { account, user } from '@/db/auth-schema';
import { accounts, paperFollows, paperIdentifiers } from '@/db/schema';
import { ensureAccountForUser } from '@/server/accounts';
import { normalizeEmail } from '@/server/affiliations';
import { institutionForEmail } from '@/server/institution-domains';

/**
 * Brings acceptodds.com's confirmed users over, so they sign in here as they did there: the address,
 * confirmed, with the same password (both sites hash with Better Auth's default scrypt), and the
 * papers they followed, by OpenReview id. Their profile here is the placeholder one a first sign-in
 * makes (`ensureAccountForUser`); their acceptodds handle and name are not copied.
 *
 * Imported accounts get `follow_mail` and `mention_mail` off, so nothing is mailed to people who
 * haven't been here yet; turn them on when that is announced. An address that already has a user
 * here keeps its password and mail settings and only gains the follows.
 *
 * Reads one JSON object per line on stdin:
 *   {"email": "...", "password": "<scrypt hash>" | null, "createdAt": "...", "follows": ["<openreview id>", ...]}
 * Dry run unless `--apply`. Safe to rerun.
 */

interface Row {
  email: string;
  password: string | null;
  createdAt: string;
  follows: string[];
}

async function main() {
  const apply = process.argv.includes('--apply');
  const db = getDb();
  const rows: Row[] = [];
  for await (const line of createInterface({ input: process.stdin })) if (line.trim()) rows.push(JSON.parse(line));

  const ids = [...new Set(rows.flatMap((r) => r.follows))];
  const paperFor = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const found = await db
      .select({ value: paperIdentifiers.value, paperId: paperIdentifiers.paperId })
      .from(paperIdentifiers)
      .where(and(eq(paperIdentifiers.scheme, 'openreview'), inArray(paperIdentifiers.value, ids.slice(i, i + 1000))));
    for (const f of found) paperFor.set(f.value, f.paperId);
  }

  const n = { rows: rows.length, created: 0, existing: 0, notAllowed: 0, passwords: 0, follows: 0, unmatched: 0 };
  for (const row of rows) {
    const email = normalizeEmail(row.email);
    if (!(await institutionForEmail(email, db))) {
      n.notAllowed += 1;
      continue;
    }
    const papers = row.follows.map((id) => paperFor.get(id)).filter((p): p is string => !!p);
    n.unmatched += row.follows.length - papers.length;
    const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (existing) n.existing += 1;
    else {
      n.created += 1;
      if (row.password) n.passwords += 1;
    }
    if (!apply) {
      n.follows += papers.length;
      continue;
    }

    let userId = existing?.id;
    if (!userId) {
      userId = randomUUID();
      const createdAt = new Date(row.createdAt);
      await db.transaction(async (tx) => {
        await tx.insert(user).values({ id: userId!, name: '', email, emailVerified: true, createdAt, updatedAt: createdAt });
        if (row.password) {
          await tx.insert(account).values({
            id: randomUUID(),
            accountId: userId!,
            providerId: 'credential',
            userId: userId!,
            password: row.password,
            createdAt,
            updatedAt: new Date(),
          });
        }
      });
    }
    const acct = await ensureAccountForUser({ id: userId, email }, db);
    if (!existing) {
      await db.update(accounts).set({ followMail: false, mentionMail: false }).where(eq(accounts.id, acct.id));
    }
    if (papers.length > 0) {
      const added = await db
        .insert(paperFollows)
        .values([...new Set(papers)].map((paperId) => ({ accountId: acct.id, paperId })))
        .onConflictDoNothing()
        .returning({ paperId: paperFollows.paperId });
      n.follows += added.length;
    }
  }
  console.log(JSON.stringify({ apply, ...n }));
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
