import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { isUniqueViolation } from '@/db/errors';
import { accounts, affiliations, type Account } from '@/db/schema';
import { handleProblem } from '@/lib/profile';
import { normalizeEmail, syncAccount } from './affiliations';
import { ApiError } from './api/errors';
import { claimByEmail } from './claims';
import { institutionForEmail } from './institution-domains';
import { refreshPages } from './pages/refresh';
import { ensureOrgPageFor } from './org-pages';
import { afterHandleChange, startUserPage, syncProfileFile } from './user-pages';

function placeholderHandle(): string {
  return `user-${randomBytes(6)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '0')
    .slice(0, 6)}`;
}

/**
 * The account for a Better Auth user whose email is **confirmed**, created if it does not exist yet,
 * verified against the institution allowlist. **Idempotent**, and safe to race: the unique index on
 * `accounts.user_id` decides, and the loser reads the winner's row.
 *
 * Called from Better Auth's `afterEmailVerification` and again, lazily, by `server/auth.ts` for every
 * session, so a user can never be signed in without an account. Never call it for an unconfirmed user.
 *
 * If another account has already confirmed the address, this one is created unverified: one address
 * vouches for one account.
 */
export async function ensureAccountForUser(
  user: { id: string; email: string },
  database: Database = getDb(),
): Promise<Account> {
  const [existing] = await database.select().from(accounts).where(eq(accounts.userId, user.id));
  if (existing) return existing;

  const institution = await institutionForEmail(user.email, database);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const created = await database.transaction(async (tx) => {
        const [account] = await tx
          .insert(accounts)
          .values({ handle: placeholderHandle(), userId: user.id })
          .returning();
        if (institution) {
          // Any conflict here is the confirmed-address index (the account is new).
          const [primary] = await tx
            .insert(affiliations)
            .values({
              accountId: account.id,
              email: normalizeEmail(user.email),
              institutionName: institution.name,
              isPrimary: true,
              verifiedAt: sql`clock_timestamp()`,
            })
            .onConflictDoNothing()
            .returning();
          if (primary) await syncAccount(tx, account.id);
        }
        const [row] = await tx.select().from(accounts).where(eq(accounts.id, account.id));
        return row;
      });
      // The sign-up address may be printed on papers: make the account their author where it says which.
      // A failure here mustn't stop the sign-up; the next confirmed address or ingest pass tries again.
      try {
        await claimByEmail({ accountId: created.id }, database);
      } catch (err) {
        console.error('claim by email', err);
      }
      // Its page at /u/<handle> exists already (a trigger made it with the account); its repo starts here.
      await startUserPage(created, database);
      // Its institution's page, if nobody from there has come before.
      if (institution) await ensureOrgPageFor(user.email, database);
      return created;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const [raced] = await database.select().from(accounts).where(eq(accounts.userId, user.id));
      if (raced) return raced;
      // Otherwise the placeholder handle was taken: try another.
    }
  }
  throw new Error(`could not find a free handle for user ${user.id}`);
}

export interface ProfileChange {
  handle?: string;
  /** `null` clears it. */
  realName?: string | null;
  showInstitution?: boolean;
  mentionMail?: boolean;
  followMail?: boolean;
}

/**
 * Change what the public sees. The first completion must choose a handle and answer about the
 * institution; nothing is assumed for the person. Page history refers to a stable id, not the
 * handle, so a handle can change freely; the account's page at `/u/<handle>` moves with it, leaving a redirect from
 * the old address until someone else takes that handle (`server/user-pages.ts`).
 */
export async function updateProfile(
  account: Account,
  requested: ProfileChange,
  database: Database = getDb(),
): Promise<Account> {
  const change = { ...requested, handle: requested.handle?.trim().toLowerCase() };
  if (!account.profileCompletedAt && (change.handle === undefined || change.showInstitution === undefined)) {
    throw new ApiError(400, 'validation_error', 'choose a handle and whether to show your institution');
  }
  if (change.handle !== undefined) {
    const problem = change.handle === account.handle ? null : handleProblem(change.handle);
    if (problem) throw new ApiError(422, 'invalid_handle', problem);
  }
  const realName = change.realName === undefined ? undefined : change.realName?.trim() || null;
  try {
    const [updated] = await database
      .update(accounts)
      .set({
        ...(change.handle !== undefined ? { handle: change.handle } : {}),
        ...(realName !== undefined ? { realName } : {}),
        ...(change.showInstitution !== undefined ? { showInstitution: change.showInstitution } : {}),
        ...(change.mentionMail !== undefined ? { mentionMail: change.mentionMail } : {}),
        ...(change.followMail !== undefined ? { followMail: change.followMail } : {}),
        profileCompletedAt: account.profileCompletedAt ?? new Date(),
      })
      .where(eq(accounts.id, account.id))
      .returning();
    // The page's profile.json says whether it shows the institution (`user-pages.ts`).
    if (updated.showInstitution !== account.showInstitution) {
      await syncProfileFile(updated, database).catch((err) => console.error('profile.json', err));
    }
    // The trigger moved the page to the new handle and left a redirect from the old one.
    if (updated.handle !== account.handle) await afterHandleChange(account.handle, updated.handle, database);
    // What the page shows may have changed (a real name), whether or not it shows it.
    else await refreshPages({ kind: 'user', key: updated.handle }).catch(() => {});
    return updated;
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, 'handle_taken', 'that handle is taken');
    throw err;
  }
}
