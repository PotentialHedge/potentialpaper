import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';
import { institutionDomains, institutionRequests } from '@/db/schema';
import { pendingByDomain } from '@/server/institution-requests';
import { devOutbox } from '@/server/mail';
import { api, closePool, lastMailTo, resetDatabase, signUp } from './helpers';

const failing = vi.hoisted(() => ({ to: null as string | null }));

vi.mock('@/server/mail', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/mail')>();
  return {
    ...real,
    sendMail: async (mail: { to: string }) => {
      if (mail.to === failing.to) throw new Error('mail is down');
      return real.sendMail(mail as Parameters<typeof real.sendMail>[0]);
    },
  };
});

beforeEach(async () => {
  failing.to = null;
  await resetDatabase();
});
afterAll(closePool);

const ask = (email: string, institutionName = 'New Institute', extra: object = {}) =>
  api('POST', '/institution-requests', { body: { email, institutionName, ...extra } });

describe('requesting an institution', () => {
  it('queues a request for a refused domain, and sends no mail on asking', async () => {
    expect((await api('POST', '/onboarding', { body: { email: 'ada@new-inst.example' } })).status).toBe(422);
    const res = await ask('ada@new-inst.example', 'New Institute', { website: 'https://new-inst.example', note: 'hi' });
    expect(res.status).toBe(202);
    expect(devOutbox()).toHaveLength(0);
    const [entry] = await pendingByDomain();
    expect(entry.domain).toBe('new-inst.example');
    expect(entry.requests[0]).toMatchObject({ institutionName: 'New Institute', note: 'hi' });
  });

  it('never shows the admin queue an address', async () => {
    await ask('ada@new-inst.example');
    expect(JSON.stringify(await pendingByDomain())).not.toContain('ada@');
  });

  it('refuses free mail and public suffixes', async () => {
    for (const email of ['ada@gmail.com', 'ada@ac.uk']) {
      const res = await ask(email);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('domain_not_institutional');
    }
    expect(await pendingByDomain()).toHaveLength(0);
  });

  it('refuses a +tag, and a domain already listed', async () => {
    expect((await ask('ada+x@new-inst.example')).status).toBe(422);
    const listed = await ask('ada@ethz.ch');
    expect(listed.status).toBe(409);
    expect(listed.body.error.code).toBe('institution_already_listed');
  });

  it('refuses a website that is not http(s), which an admin would click', async () => {
    const res = await ask('ada@new-inst.example', 'New Institute', { website: 'javascript:alert(1)' });
    expect(res.status).toBe(400);
  });

  it('keeps one open request per address, replacing the old one', async () => {
    await ask('ada@new-inst.example', 'First Name');
    await ask('ada@new-inst.example', 'Second Name');
    const [entry] = await pendingByDomain();
    expect(entry.requests.map((r) => r.institutionName)).toEqual(['Second Name']);
  });

  it('groups different people asking for one domain', async () => {
    await ask('ada@new-inst.example');
    await ask('bob@new-inst.example');
    const queue = await pendingByDomain();
    expect(queue).toHaveLength(1);
    expect(queue[0].requests).toHaveLength(2);
  });

  it('limits how often one address can ask', async () => {
    let last = 202;
    for (let i = 0; i < 4; i += 1) last = (await ask('ada@new-inst.example')).status;
    expect(last).toBe(429);
  });
});

describe('deciding', () => {
  const approve = (cookie: string | undefined, domain: string, institutionName = 'New Institute') =>
    api('POST', '/admin/institutions/approve', { cookie, body: { domain, institutionName } });

  it('is for admins only', async () => {
    await ask('ada@new-inst.example');
    expect((await approve(undefined, 'new-inst.example')).status).toBe(401);
    const member = await signUp('bob@ethz.ch');
    const refused = await approve(member, 'new-inst.example');
    expect(refused.status).toBe(403);
    const rejected = await api('POST', '/admin/institutions/reject', {
      cookie: member,
      body: { domain: 'new-inst.example' },
    });
    expect(rejected.status).toBe(403);
    expect(await getDb().select().from(institutionDomains)).toHaveLength(0);
  });

  it('approval works at once: no restart, and the person can sign up', async () => {
    await ask('ada@new-inst.example');
    expect((await api('POST', '/onboarding', { body: { email: 'ada@new-inst.example' } })).status).toBe(422);
    const admin = await signUp('admin@example.org');
    const res = await approve(admin, 'new-inst.example', 'The New Institute');
    expect(res.body).toEqual({ decided: 1, mailed: 1, mailFailed: 0 });
    expect(lastMailTo('ada@new-inst.example')?.subject).toContain('The New Institute can now join');
    const cookie = await signUp('ada@new-inst.example');
    expect((await api('GET', '/me', { cookie })).body.institutions).toEqual(['The New Institute']);
  });

  it('deletes the address once the answer has gone out, and keeps the record', async () => {
    await ask('ada@new-inst.example');
    await approve(await signUp('admin@example.org'), 'new-inst.example');
    const [row] = await getDb().select().from(institutionRequests);
    expect(row.email).toBeNull();
    expect(row.status).toBe('approved');
    expect(row.decidedBy).not.toBeNull();
    expect(await pendingByDomain()).toHaveLength(0);
  });

  it('keeps the address when the mail fails, and repeating the decision retries it', async () => {
    await ask('ada@new-inst.example');
    await ask('bob@new-inst.example');
    const admin = await signUp('admin@example.org');
    failing.to = 'ada@new-inst.example';
    const first = await approve(admin, 'new-inst.example');
    expect(first.body).toEqual({ decided: 2, mailed: 1, mailFailed: 1 });
    failing.to = null;
    const retry = await approve(admin, 'new-inst.example');
    expect(retry.body).toEqual({ decided: 1, mailed: 1, mailFailed: 0 });
    const rows = await getDb().select().from(institutionRequests);
    expect(rows.every((r) => r.email === null)).toBe(true);
    expect((await approve(admin, 'new-inst.example')).status).toBe(404);
  });

  it('can widen to a parent, answering requests under it and admitting its other subdomains', async () => {
    await ask('ada@cs.new-inst.example');
    await ask('bob@bio.new-inst.example');
    const res = await approve(await signUp('admin@example.org'), 'new-inst.example');
    expect(res.body.decided).toBe(2);
    expect(await pendingByDomain()).toHaveLength(0);
    expect((await api('POST', '/onboarding', { body: { email: 'eve@maths.new-inst.example' } })).status).toBe(202);
  });

  it('cannot add a domain nobody asked for, or that could not be an institution', async () => {
    await ask('ada@new-inst.example');
    const admin = await signUp('admin@example.org');
    expect((await approve(admin, 'unasked.example')).status).toBe(404);
    expect((await approve(admin, 'gmail.com')).status).toBe(422);
    expect(await getDb().select().from(institutionDomains)).toHaveLength(0);
  });

  it('a parent does not match a look-alike domain', async () => {
    await ask('ada@not-new-inst.example');
    expect((await approve(await signUp('admin@example.org'), 'new-inst.example')).status).toBe(404);
  });

  it('rejection tells the person, deletes the address and does not admit the domain', async () => {
    await ask('ada@new-inst.example');
    const admin = await signUp('admin@example.org');
    const res = await api('POST', '/admin/institutions/reject', {
      cookie: admin,
      body: { domain: 'new-inst.example', reason: 'This is a hosting provider.' },
    });
    expect(res.body).toEqual({ decided: 1, mailed: 1, mailFailed: 0 });
    expect(lastMailTo('ada@new-inst.example')?.text).toContain('This is a hosting provider.');
    const [row] = await getDb().select().from(institutionRequests);
    expect(row).toMatchObject({ status: 'rejected', email: null });
    expect((await api('POST', '/onboarding', { body: { email: 'ada@new-inst.example' } })).status).toBe(422);
  });

  it('lets someone ask again after a rejection', async () => {
    await ask('ada@new-inst.example');
    const admin = await signUp('admin@example.org');
    await api('POST', '/admin/institutions/reject', { cookie: admin, body: { domain: 'new-inst.example' } });
    expect((await ask('ada@new-inst.example')).status).toBe(202);
    expect(await pendingByDomain()).toHaveLength(1);
  });
});
