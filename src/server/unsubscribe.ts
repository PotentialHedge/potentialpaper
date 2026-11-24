import { createHmac, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts } from '@/db/schema';
import { siteUrl } from './site';

/**
 * One-click unsubscribe (RFC 8058) for notification mail: the `List-Unsubscribe` and `List-Unsubscribe-Post`
 * headers, which Gmail and Yahoo look for, and show as an "Unsubscribe" button, so people use it instead of
 * "Report spam". The address carries a signed token naming the account and the kind of mail, derived from
 * `BETTER_AUTH_SECRET` as `server/internal.ts` does, so it works without signing in.
 */

export type MailKind = 'mention' | 'follow';
const KINDS: readonly MailKind[] = ['mention', 'follow'];

export const UNSUBSCRIBE_PATH = '/api/unsubscribe';

function sign(payload: string): string | null {
  const base = process.env.BETTER_AUTH_SECRET;
  if (!base) return null;
  const key = createHmac('sha256', base).update('potentialpaper unsubscribe').digest();
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, 32);
}

export function unsubscribeToken(accountId: string, kind: MailKind): string | null {
  const payload = `${kind}.${accountId}`;
  const sig = sign(payload);
  return sig ? `${payload}.${sig}` : null;
}

export function readUnsubscribeToken(token: string): { accountId: string; kind: MailKind } | null {
  const [kind, accountId, given, ...rest] = token.split('.');
  if (rest.length || !accountId || !given || !KINDS.includes(kind as MailKind)) return null;
  const want = sign(`${kind}.${accountId}`);
  if (!want) return null;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b) ? { accountId, kind: kind as MailKind } : null;
}

/** The headers for a notification mail of `kind` to `accountId`; none without a secret to sign with. */
export function unsubscribeHeaders(accountId: string, kind: MailKind): Record<string, string> {
  const token = unsubscribeToken(accountId, kind);
  if (!token) return {};
  return {
    'List-Unsubscribe': `<${siteUrl()}${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/** Turns that kind of mail off for the account. Whether the token was good. */
export async function unsubscribe(token: string, database: Database = getDb()): Promise<boolean> {
  const t = readUnsubscribeToken(token);
  if (!t) return false;
  await database
    .update(accounts)
    .set(t.kind === 'mention' ? { mentionMail: false } : { followMail: false })
    .where(eq(accounts.id, t.accountId));
  return true;
}
