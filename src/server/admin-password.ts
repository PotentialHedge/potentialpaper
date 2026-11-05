import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { account, session, user } from '@/db/auth-schema';
import { ensureAccountForUser } from './accounts';
import { isAdminEmail } from './auth';

/** 192 random bits, URL-safe so it survives copying and shells. */
export function generateAdminPassword(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Give an address in `ADMIN_EMAILS` this password, creating its user and account if needed, so an
 * admin can get in without any mail. Whoever runs this has the production database, which is why the
 * address counts as confirmed. Ends the address's existing sessions, so a new password locks out
 * anyone holding an old one.
 */
export async function setAdminPassword(
  rawEmail: string,
  password: string,
  database: Database = getDb(),
): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!isAdminEmail(email)) throw new Error(`${email} is not in ADMIN_EMAILS`);
  const hash = await hashPassword(password);

  const userId = await database.transaction(async (tx) => {
    const [existing] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await tx.update(user).set({ emailVerified: true }).where(eq(user.id, id));
    } else {
      await tx.insert(user).values({ id, name: '', email, emailVerified: true });
    }
    const updated = await tx
      .update(account)
      .set({ password: hash })
      .where(and(eq(account.userId, id), eq(account.providerId, 'credential')))
      .returning({ id: account.id });
    if (updated.length === 0) {
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: id,
        providerId: 'credential',
        userId: id,
        password: hash,
        updatedAt: new Date(),
      });
    }
    await tx.delete(session).where(eq(session.userId, id));
    return id;
  });

  await ensureAccountForUser({ id: userId, email }, database);
}
