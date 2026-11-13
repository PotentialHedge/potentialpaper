import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Calls from the site's own processes outside Next (the SSH server, scripts) to the app, for what only works
 * inside a Next request: today, refreshing pages' cached HTML (`api/internal/revalidate`). The credential is
 * derived from `BETTER_AUTH_SECRET`, which every process already has, so there is no secret of its own to
 * hand out; `APP_INTERNAL_URL` says where the app is (`http://app:3000` in production's compose network).
 */

export const INTERNAL_REVALIDATE = '/api/internal/revalidate';

function internalSecret(): string | null {
  const base = process.env.BETTER_AUTH_SECRET;
  return base ? createHmac('sha256', base).update('potentialpaper internal: revalidate').digest('base64url') : null;
}

/** Whether a request carries the internal credential. */
export function isInternalRequest(req: Request): boolean {
  const secret = internalSecret();
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Asks the app to revalidate `paths`. `false` when there is no app to ask (`APP_INTERNAL_URL` unset, as in
 * tests) or it didn't answer; never throws.
 */
export async function revalidateInApp(paths: readonly string[]): Promise<boolean> {
  const base = process.env.APP_INTERNAL_URL?.replace(/\/+$/, '');
  const secret = internalSecret();
  if (!base || !secret || paths.length === 0) return false;
  try {
    const res = await fetch(`${base}${INTERNAL_REVALIDATE}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('revalidate in app', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (err) {
    console.error('revalidate in app', err);
    return false;
  }
}
