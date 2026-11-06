import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { user } from '@/db/auth-schema';
import { accounts, affiliations } from '@/db/schema';
import { pruneUnconfirmedUsers } from '@/server/onboarding';
import { devOutbox } from '@/server/mail';
import { api, authCall, closePool, lastMailTo, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

describe('signing up', () => {
  it('refuses a domain off the list with a 422, before any user or mail exists', async () => {
    const res = await api('POST', '/onboarding', { body: { email: 'someone@not-listed.example' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('email_domain_not_allowed');
    expect(await getDb().select().from(user)).toHaveLength(0);
    expect(devOutbox()).toHaveLength(0);
  });

  it('refuses a +tag, even on a listed domain', async () => {
    const res = await api('POST', '/onboarding', { body: { email: 'ada+x@ethz.ch' } });
    expect(res.status).toBe(422);
  });

  it('admits subdomains of a listed domain, but a listed bare TLD admits nobody', async () => {
    expect((await api('POST', '/onboarding', { body: { email: 'ada@inf.ethz.ch' } })).status).toBe(202);
    expect((await api('POST', '/onboarding', { body: { email: 'ada@anything.uk' } })).status).toBe(422);
  });

  it('makes no account until the address is confirmed', async () => {
    await api('POST', '/onboarding', { body: { email: 'ada@ethz.ch' } });
    expect(await getDb().select().from(accounts)).toHaveLength(0);
  });

  it('confirming by code signs in and makes a verified account with its institution', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const me = await api('GET', '/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.body.verified).toBe(true);
    expect(me.body.institutions).toEqual(['ETH Zurich']);
    const [primary] = await getDb()
      .select()
      .from(affiliations)
      .where(and(eq(affiliations.email, 'ada@ethz.ch'), eq(affiliations.isPrimary, true)));
    expect(primary.verifiedAt).not.toBeNull();
  });

  it('answers the same for an address with an account, and mails it instead of making another', async () => {
    await signUp('ada@ethz.ch');
    const res = await api('POST', '/onboarding', { body: { email: 'ada@ethz.ch' } });
    expect(res.status).toBe(202);
    expect(lastMailTo('ada@ethz.ch')?.text).toContain('already has a potentialpaper account');
    expect(await getDb().select().from(accounts)).toHaveLength(1);
  });

  it('limits the mail one address can receive', async () => {
    let last = 202;
    for (let i = 0; i < 6; i += 1) last = (await api('POST', '/onboarding', { body: { email: 'ada@ethz.ch' } })).status;
    expect(last).toBe(429);
  });

  it('never takes a password through Better Auth’s own sign-up', async () => {
    const res = await authCall('POST', '/sign-up/email', {
      body: { email: 'ada@ethz.ch', password: 'correct horse battery', name: 'x' },
    });
    expect(res.status).toBe(404);
  });

  it('sets a first password once', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const first = await api('POST', '/me/password', { cookie, body: { password: 'correct horse battery' } });
    expect(first.status).toBe(200);
    const second = await api('POST', '/me/password', { cookie, body: { password: 'another long password' } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('password_already_set');
  });

  it('prunes old unconfirmed sign-ups, never a confirmed one', async () => {
    await signUp('confirmed@ethz.ch');
    await api('POST', '/onboarding', { body: { email: 'unconfirmed@ethz.ch' } });
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await pruneUnconfirmedUsers({ now: later })).toBe(1);
    const left = await getDb().select({ email: user.email }).from(user);
    expect(left.map((u) => u.email)).toEqual(['confirmed@ethz.ch']);
  });
});

describe('the session', () => {
  it('refuses a cross-origin write, even with a valid cookie', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const res = await api('PATCH', '/me', {
      cookie,
      origin: 'https://evil.example',
      body: { handle: 'stolen', showInstitution: true },
    });
    expect(res.status).toBe(403);
  });

  it('wants a sign-in for personal routes', async () => {
    expect((await api('GET', '/me')).status).toBe(401);
  });

  it('answers a wrong method in the one error shape', async () => {
    const res = await api('DELETE', '/me');
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('method_not_allowed');
  });
});

describe('the public profile', () => {
  it('starts with a placeholder and hides the institution, assuming nothing', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const { body } = await api('GET', '/me', { cookie });
    expect(body.handle).toMatch(/^user-[a-z0-9]{6}$/);
    expect(body.realName).toBeNull();
    expect(body.showInstitution).toBe(false);
    expect(body.profileComplete).toBe(false);
  });

  it('must choose both a handle and an answer about the institution to complete', async () => {
    const cookie = await signUp('ada@ethz.ch');
    expect((await api('PATCH', '/me', { cookie, body: { handle: 'ada' } })).status).toBe(400);
    expect((await api('PATCH', '/me', { cookie, body: { showInstitution: true } })).status).toBe(400);
    const done = await api('PATCH', '/me', { cookie, body: { handle: 'ada', showInstitution: false } });
    expect(done.status).toBe(200);
    expect(done.body.profileComplete).toBe(true);
  });

  it('leaves the real name optional, and clearable', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const named = await api('PATCH', '/me', {
      cookie,
      body: { handle: 'ada', showInstitution: true, realName: '  Ada Lovelace ' },
    });
    expect(named.body.realName).toBe('Ada Lovelace');
    expect((await api('PATCH', '/me', { cookie, body: { realName: null } })).body.realName).toBeNull();
    expect((await api('PATCH', '/me', { cookie, body: { realName: '   ' } })).body.realName).toBeNull();
  });

  it('refuses a reserved handle and a taken one', async () => {
    const ada = await signUp('ada@ethz.ch');
    const bob = await signUp('bob@ethz.ch');
    await api('PATCH', '/me', { cookie: ada, body: { handle: 'ada', showInstitution: false } });
    const reserved = await api('PATCH', '/me', { cookie: bob, body: { handle: 'admin', showInstitution: false } });
    expect(reserved.body.error.code).toBe('invalid_handle');
    const taken = await api('PATCH', '/me', { cookie: bob, body: { handle: 'ada', showInstitution: false } });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('handle_taken');
  });
});

describe('affiliations', () => {
  it('adds a second address only with the code mailed to it', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const added = await api('POST', '/me/affiliations', { cookie, body: { email: 'ada@example.org' } });
    expect(added.status).toBe(201);
    const wrong = await api('POST', `/me/affiliations/${added.body.id}/verify`, { cookie, body: { code: '000000' } });
    // One in a million that the random code is 000000.
    expect(wrong.body.error?.code).toBe('invalid_code');
    const code = /\b(\d{6})\b/.exec(lastMailTo('ada@example.org')!.subject)![1];
    const ok = await api('POST', `/me/affiliations/${added.body.id}/verify`, { cookie, body: { code } });
    expect(ok.status).toBe(200);
    expect((await api('GET', '/me', { cookie })).body.institutions).toEqual(['ETH Zurich', 'Example University']);
  });

  it('never removes the sign-up address', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const { body } = await api('GET', '/me/affiliations', { cookie });
    const res = await api('DELETE', `/me/affiliations/${body.affiliations[0].id}`, { cookie });
    expect(res.body.error.code).toBe('primary_affiliation');
  });

  it('lets one address vouch for one account: the other is told by mail, with no code', async () => {
    await signUp('ada@ethz.ch');
    const bob = await signUp('bob@example.org');
    const added = await api('POST', '/me/affiliations', { cookie: bob, body: { email: 'ada@ethz.ch' } });
    // Looks the same to Bob, so nobody learns which addresses have accounts.
    expect(added.status).toBe(201);
    const mail = lastMailTo('ada@ethz.ch')!;
    expect(mail.subject).toContain('already affiliated');
    expect(mail.subject).not.toMatch(/\d{6}/);
  });
});
