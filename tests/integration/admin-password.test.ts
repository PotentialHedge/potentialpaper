import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { user } from '@/db/auth-schema';
import { generateAdminPassword, setAdminPassword } from '@/server/admin-password';
import { authenticate } from '@/server/auth';
import { api, authCall, closePool, cookieFrom, ORIGIN, resetDatabase, signUp } from './helpers';

const ADMIN = 'ada@inf.ethz.ch';
const adminEmailsBefore = process.env.ADMIN_EMAILS;

beforeEach(async () => {
  await resetDatabase();
  process.env.ADMIN_EMAILS = ADMIN;
});
afterEach(() => {
  process.env.ADMIN_EMAILS = adminEmailsBefore;
});
afterAll(closePool);

const signIn = (email: string, password: string) => authCall('POST', '/sign-in/email', { body: { email, password } });

describe('setting an admin password', () => {
  it('creates a verified admin who can sign in with it, with no mail', async () => {
    const password = generateAdminPassword();
    await setAdminPassword(ADMIN, password);

    const res = await signIn(ADMIN, password);
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    const me = await api('GET', '/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.body.verified).toBe(true);
    const principal = await authenticate(new Request(ORIGIN, { headers: { cookie } }));
    expect(principal?.isAdmin).toBe(true);
  });

  it('replaces the old password and ends existing sessions, keeping the same user', async () => {
    const cookie = await signUp(ADMIN);
    const first = generateAdminPassword();
    await setAdminPassword(ADMIN, first);
    expect((await api('GET', '/me', { cookie })).status).toBe(401);

    const second = generateAdminPassword();
    await setAdminPassword(ADMIN, second);
    expect((await signIn(ADMIN, first)).status).toBe(401);
    expect((await signIn(ADMIN, second)).status).toBe(200);
    expect(await getDb().select().from(user)).toHaveLength(1);
  });

  it('refuses an address not in ADMIN_EMAILS', async () => {
    await expect(setAdminPassword('bob@ethz.ch', generateAdminPassword())).rejects.toThrow('ADMIN_EMAILS');
    expect(await getDb().select().from(user)).toHaveLength(0);
  });
});
