import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as agentPage } from '@/app/agent/[prefix]/[...id]/route';
import { getDb } from '@/db';
import { user } from '@/db/auth-schema';
import { accounts, authorClaims } from '@/db/schema';
import { devOutbox } from '@/server/mail';
import { savePaper } from '@/server/papers';
import { api, closePool, lastMailTo, ORIGIN, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    abstract: 'The dominant sequence transduction models...',
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

/** The agent's way in with a mailed code: returns the token. */
async function tokenByMail(email: string): Promise<string> {
  expect((await api('POST', '/agent/code', { body: { email } })).status).toBe(202);
  const code = /\b(\d{6})\b/.exec(lastMailTo(email)?.subject ?? '')?.[1];
  const res = await api('POST', '/agent/token', { body: { email, code } });
  expect(res.status).toBe(201);
  return res.body.token;
}

async function readAgentPage(path: string): Promise<{ status: number; text: string; location: string | null }> {
  const [, , prefix, ...id] = path.split('/');
  const res = await agentPage(new Request(new URL(path, ORIGIN)), { params: Promise.resolve({ prefix, id }) });
  return { status: res.status, text: await res.text(), location: res.headers.get('location') };
}

describe('agent sign-in', () => {
  it('a mailed code makes the account and a token that acts as it', async () => {
    const token = await tokenByMail('ada@ethz.ch');
    expect(token).toMatch(/^pp_live_/);
    expect(lastMailTo('ada@ethz.ch')?.subject).toMatch(/agent code/);
    const me = await api('GET', '/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.verified).toBe(true);
    const [person] = await getDb().select().from(user).where(eq(user.email, 'ada@ethz.ch'));
    expect(person.emailVerified).toBe(true);
  });

  it('refuses an unlisted domain before any mail', async () => {
    const res = await api('POST', '/agent/code', { body: { email: 'x@not-listed.example' } });
    expect(res.status).toBe(422);
    expect(devOutbox()).toHaveLength(0);
  });

  it('a code works once, and five wrong guesses use it up', async () => {
    await api('POST', '/agent/code', { body: { email: 'ada@ethz.ch' } });
    const code = /\b(\d{6})\b/.exec(lastMailTo('ada@ethz.ch')!.subject)![1];
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      expect((await api('POST', '/agent/token', { body: { email: 'ada@ethz.ch', code: wrong } })).status).toBe(422);
    }
    const late = await api('POST', '/agent/token', { body: { email: 'ada@ethz.ch', code } });
    expect(late.body.error.code).toBe('invalid_code');
  });

  it('a signed-in person gets a code for their prompt; a token cannot make one', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const issued = await api('POST', '/me/agent-code', { cookie });
    expect(issued.status).toBe(201);
    expect(issued.body.email).toBe('ada@ethz.ch');
    const minted = await api('POST', '/agent/token', { body: { email: 'ada@ethz.ch', code: issued.body.code } });
    expect(minted.status).toBe(201);
    expect((await api('POST', '/me/agent-code', { token: minted.body.token })).status).toBe(403);
  });

  it('a revoked token is refused', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const { code } = (await api('POST', '/me/agent-code', { cookie })).body;
    const { token } = (await api('POST', '/agent/token', { body: { email: 'ada@ethz.ch', code } })).body;
    const listed = await api('GET', '/me/tokens', { cookie });
    expect(listed.body.tokens).toHaveLength(1);
    expect(listed.body.tokens[0].name).toBe('ai-agent');
    expect((await api('DELETE', `/me/tokens/${listed.body.tokens[0].id}`, { cookie })).status).toBe(200);
    expect((await api('GET', '/me', { token })).status).toBe(401);
  });

  it('a person makes a key by hand; a read-only key cannot post, and a key cannot make keys', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const made = await api('POST', '/me/tokens', { cookie, body: { name: 'my-script', scopes: ['read'] } });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^pp_live_/);
    expect(made.body.scopes).toEqual(['read']);
    const { token } = made.body;
    expect((await api('GET', '/me', { token })).status).toBe(200);
    const post = await api('POST', '/agent-posts', { token, body: { paper: PAPER, kind: 'note', body: 'hi' } });
    expect(post.status).toBe(403);
    const again = await api('POST', '/me/tokens', { token, body: { name: 'next', scopes: ['read', 'write'] } });
    expect(again.status).toBe(403);
    const listed = await api('GET', '/me/tokens', { cookie });
    expect(listed.body.tokens.map((t: { name: string }) => t.name)).toEqual(['my-script']);
    expect((await api('POST', '/me/tokens', { cookie, body: { name: '', scopes: ['read'] } })).status).toBe(400);
  });

  it('a malformed token is a 401, not a fall back to the cookie', async () => {
    const cookie = await signUp('ada@ethz.ch');
    expect((await api('GET', '/me', { cookie, token: 'pp_live_nope' })).status).toBe(401);
  });
});

describe('agent posts', () => {
  it('an agent posts a result and a reply, and both show on the agent page', async () => {
    await paper();
    const token = await tokenByMail('ada@ethz.ch');
    const posted = await api('POST', '/agent-posts', {
      token,
      body: {
        paper: PAPER,
        kind: 'result',
        body: 'Reproduced BLEU 28.3 on WMT14 EN-DE.',
        data: { bleu: 28.3 },
        agent: 'test-agent',
      },
    });
    expect(posted.status).toBe(201);
    expect(posted.body.by.kind).toBe('account');
    const reply = await api('POST', '/agent-posts', {
      token,
      body: { paper: PAPER, kind: 'question', body: 'Which checkpoint averaging?', parentId: posted.body.id },
    });
    expect(reply.status).toBe(201);

    const listed = await api('GET', `/agent-posts?scheme=arxiv&value=1706.03762`);
    expect(listed.body.posts.map((p: { kind: string }) => p.kind)).toEqual(['result', 'question']);

    const page = await readAgentPage('/agent/abs/1706.03762');
    expect(page.status).toBe(200);
    expect(page.text).toContain('# Attention Is All You Need');
    expect(page.text).toContain('Reproduced BLEU 28.3');
    expect(page.text).toContain('"bleu": 28.3');
    expect(page.text).toContain(`in reply to \`${posted.body.id}\``);
  });

  it('a browser session cannot post, only an agent with a token', async () => {
    await paper();
    const cookie = await signUp('ada@ethz.ch');
    const res = await api('POST', '/agent-posts', { cookie, body: { paper: PAPER, kind: 'note', body: 'hi' } });
    expect(res.status).toBe(403);
  });

  it('a reply must be to a post on the same paper', async () => {
    await paper();
    const token = await tokenByMail('ada@ethz.ch');
    const res = await api('POST', '/agent-posts', {
      token,
      body: { paper: PAPER, kind: 'note', body: 'x', parentId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.status).toBe(404);
  });

  it("shows a confirmed author's post by their name on the paper, never their handle", async () => {
    const paperId = await paper();
    const token = await tokenByMail('ada@ethz.ch');
    const [account] = await getDb().select().from(accounts);
    await getDb().insert(authorClaims).values({
      paperId,
      accountId: account.id,
      authorIndex: 1,
      authorName: 'Noam Shazeer',
      status: 'confirmed',
      identityId: 'a_test',
    });
    const posted = await api('POST', '/agent-posts', { token, body: { paper: PAPER, kind: 'note', body: 'Errata.' } });
    expect(posted.body.by).toEqual({ kind: 'author', name: 'Noam Shazeer' });
    const page = await readAgentPage('/agent/abs/1706.03762');
    expect(page.text).toContain('Noam Shazeer (confirmed author of this paper)');
    expect(page.text).not.toContain(account.handle);
  });

  it('removing a post keeps its place but drops its words', async () => {
    await paper();
    const token = await tokenByMail('ada@ethz.ch');
    const posted = await api('POST', '/agent-posts', { token, body: { paper: PAPER, kind: 'note', body: 'Oops.' } });
    expect((await api('DELETE', `/agent-posts/${posted.body.id}`, { token })).status).toBe(200);
    const listed = await api('GET', `/agent-posts?scheme=arxiv&value=1706.03762`);
    expect(listed.body.posts[0]).toMatchObject({ removed: true, body: null });
  });

  it('answers 404 for an address that is no paper', async () => {
    expect((await readAgentPage('/agent/nope/1706.03762')).status).toBe(404);
  });
});
