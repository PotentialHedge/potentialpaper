import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageProtection, PROTECTION_LEVELS } from '@/db/schema';
import { KINDS, type PageKind } from '@/lib/kinds';
import { ApiError } from './api/errors';
import type { Actor } from './pages/check';
import type { PageRow } from './pages/kinds';
import type { Reader } from './pages/repo';
import { grantCovers, partOf } from './pages/rules';

/**
 * Page protection (DESIGN.md §7, `handoffs/pages.md` Phase 5): per-page levels that hold back who may edit a page
 * that is being fought over, as Wikipedia's do. A page has none until an admin sets one (`page_protection`).
 *
 * - `established`: only accounts whose institutional address was confirmed at least `ESTABLISHED_DAYS` ago, so a
 *   fresh account can't take part in an edit war;
 * - `admins`: admins only.
 *
 * It holds the paths the community writes. The owners' part (`owners/`) stays its owners', a bot's granted paths stay the bot's, and the system is never
 * held: protection is against edit wars among people, not a way to take a page from those it belongs to. Checked for
 * every commit, a web edit or a push alike (`check.ts`'s `checkTree`).
 */

export type ProtectionLevel = (typeof PROTECTION_LEVELS)[number];

/** How long an account has had a confirmed address before an `established`-protected page lets it edit. */
export const ESTABLISHED_DAYS = 4;

export function isProtectionLevel(value: string): value is ProtectionLevel {
  return (PROTECTION_LEVELS as readonly string[]).includes(value);
}

/** Whether an account confirmed `verifiedAt` counts as established at `now`. */
export function isEstablished(verifiedAt: Date | null, now: Date = new Date()): boolean {
  return verifiedAt !== null && now.getTime() - verifiedAt.getTime() >= ESTABLISHED_DAYS * 24 * 60 * 60 * 1000;
}

/** What a protection says on the page and in a refusal. */
export function protectionWords(level: ProtectionLevel): string {
  return level === 'admins'
    ? 'only admins can edit it'
    : `only accounts verified for at least ${ESTABLISHED_DAYS} days can edit it`;
}

export interface Protection {
  level: ProtectionLevel;
  reason: string | null;
  setAt: Date;
  expiresAt: Date | null;
}

/** A page's protection now, or `null` if it has none (or it lapsed). */
export async function protectionOf(db: Reader, pageId: string, now: Date = new Date()): Promise<Protection | null> {
  const [row] = await db
    .select({
      level: pageProtection.level,
      reason: pageProtection.reason,
      setAt: pageProtection.setAt,
      expiresAt: pageProtection.expiresAt,
    })
    .from(pageProtection)
    .where(
      and(eq(pageProtection.pageId, pageId), or(isNull(pageProtection.expiresAt), gt(pageProtection.expiresAt, now))),
    );
  return row ?? null;
}

/** Who is asking, as protection weighs them. */
export interface ProtectionRoles {
  system: boolean;
  admin: boolean;
  owner: boolean;
  established?: boolean;
  grants?: readonly string[];
}

/** Whether the protection holds this path for these roles: the community's paths, for those below the level. */
export function protectionHolds(
  level: ProtectionLevel,
  path: string,
  roles: ProtectionRoles,
  kind: PageKind = 'paper',
): boolean {
  if (roles.system || roles.admin) return false;
  if (roles.grants?.some((pattern) => grantCovers(pattern, path))) return false;
  const owners = KINDS[kind].owners;
  if (owners && roles.owner && partOf(path, kind) === owners.dir) return false;
  return level === 'admins' || !roles.established;
}

/** Refuses changes to these paths that the page's protection holds for these roles. */
export async function checkProtection(
  db: Reader,
  pageId: string,
  roles: ProtectionRoles & { kind?: PageKind },
  paths: readonly string[],
): Promise<void> {
  if (roles.system || roles.admin || paths.length === 0) return;
  const protection = await protectionOf(db, pageId);
  if (!protection) return;
  const held = paths.find((path) => protectionHolds(protection.level, path, roles, roles.kind));
  if (held === undefined) return;
  throw new ApiError(
    403,
    'page_protected',
    `this page is protected: ${protectionWords(protection.level)}${protection.reason ? ` (${protection.reason})` : ''}`,
    { path: held, level: protection.level },
  );
}

/** Sets or lifts a page's protection. Admins only; `level` `null` lifts it. */
export async function setProtection(
  page: PageRow,
  input: { level: ProtectionLevel | null; reason?: string | null; expiresAt?: Date | null },
  actor: Actor,
  database: Database = getDb(),
): Promise<Protection | null> {
  if (actor.kind === 'account' && !actor.isAdmin) {
    throw new ApiError(403, 'forbidden', 'only admins protect pages');
  }
  if (input.level === null) {
    await database.delete(pageProtection).where(eq(pageProtection.pageId, page.id));
    return null;
  }
  const values = {
    pageId: page.id,
    level: input.level,
    reason: input.reason?.trim() || null,
    setBy: actor.kind === 'account' ? actor.accountId : null,
    setAt: new Date(),
    expiresAt: input.expiresAt ?? null,
  };
  await database
    .insert(pageProtection)
    .values(values)
    .onConflictDoUpdate({ target: pageProtection.pageId, set: values });
  return protectionOf(database, page.id);
}
