import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims } from '@/db/schema';
import { decideClaim } from '@/server/claims';
import { postComment } from '@/server/comments';
import { mailCommentFollowers, mailEditFollowers } from '@/server/follows';
import { devOutbox } from '@/server/mail';
import { readUnsubscribeToken, unsubscribe } from '@/server/unsubscribe';
import { commitPage } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, lastMailTo, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;
const STATE = '/follows?scheme=arxiv&value=1706.03762';

function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    abstract: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

/** A verified account with its handle chosen. */
async function person(handle: string) {
  const cookie = await signUp(`${handle}@ethz.ch`);
  const done = await api('PATCH', '/me', { cookie, body: { handle, showInstitution: true } });
  expect(done.status).toBe(200);
  const [account] = await getDb().select().from(accounts).where(eq(accounts.handle, handle));
  return { cookie, account };
}

describe('following papers', () => {
  it('follows and unfollows, shows only the count publicly, and lists them on My papers', async () => {
    await paper();
    const ada = await person('ada');
    expect((await api('GET', STATE)).body).toEqual({ following: null, followers: 0 });
    expect((await api('GET', STATE, { cookie: ada.cookie })).body).toEqual({ following: false, followers: 0 });

    const followed = await api('POST', '/follows', { cookie: ada.cookie, body: { paper: PAPER } });
    expect(followed.body).toEqual({ following: true, followers: 1 });
    // Again changes nothing.
    await api('POST', '/follows', { cookie: ada.cookie, body: { paper: PAPER } });
    expect((await api('GET', STATE)).body).toEqual({ following: null, followers: 1 });

    const mine = await api('GET', '/me/papers', { cookie: ada.cookie });
    expect(mine.body.following).toHaveLength(1);
    expect(mine.body.following[0]).toMatchObject({ title: 'Attention Is All You Need', paper: PAPER });

    const gone = await api('DELETE', STATE, { cookie: ada.cookie });
    expect(gone.body).toEqual({ following: false, followers: 0 });
    expect((await api('POST', '/follows', { body: { paper: PAPER } })).status).toBe(401);
  });

  it('makes a confirmed author follow their paper', async () => {
    const paperId = await paper();
    const ashish = await person('ashish');
    await api('POST', '/claims', { cookie: ashish.cookie, body: { paper: PAPER, authorIndex: 0 } });
    expect((await api('GET', STATE, { cookie: ashish.cookie })).body.following).toBe(false);
    const [claim] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
    await decideClaim(claim.id, 'confirmed', null);
    expect((await api('GET', STATE, { cookie: ashish.cookie })).body.following).toBe(true);
  });

  it('mails followers about edits, at most once an hour, never the editor', async () => {
    const paperId = await paper();
    const ada = await person('ada');
    const bob = await person('bob');
    await api('POST', '/follows', { cookie: ada.cookie, body: { paper: PAPER } });
    await api('POST', '/follows', { cookie: bob.cookie, body: { paper: PAPER } });

    const actor = { kind: 'account' as const, accountId: bob.account.id, isAdmin: false };
    const edit = await commitPage(
      paperId,
      await readHead(getDb(), paperId),
      actor,
      [{ path: 'community/10-summary.md', content: '# Summary\n\nA short summary.\n' }],
      'Add a summary',
    );
    expect(edit.status).toBe('committed');
    if (edit.status !== 'committed') return;
    expect(await mailEditFollowers(paperId, bob.account.id, [edit.seq])).toBe(1);
    expect(lastMailTo('ada@ethz.ch')?.subject).toBe('Edited: “Attention Is All You Need”');
    expect(lastMailTo('ada@ethz.ch')?.text).toMatch(/\/history\/s\/\d+/);
    expect(devOutbox().some((m) => m.to === 'bob@ethz.ch' && m.subject.startsWith('Edited'))).toBe(false);

    // The next edit within the hour sends nothing.
    expect(await mailEditFollowers(paperId, bob.account.id, [edit.seq])).toBe(0);
  });

  it('mails followers about comments, but not the commenter, someone mentioned, or who turned it off', async () => {
    const paperId = await paper();
    const ada = await person('ada');
    const bob = await person('bob');
    const cyd = await person('cyd');
    for (const p of [ada, bob, cyd]) await api('POST', '/follows', { cookie: p.cookie, body: { paper: PAPER } });
    await api('PATCH', '/me', { cookie: cyd.cookie, body: { followMail: false } });

    const before = devOutbox().length;
    const comment = await postComment({ paperId, account: bob.account, body: 'Nice result.' });
    expect(await mailCommentFollowers(comment.id)).toBe(1);
    expect(devOutbox().length).toBe(before + 1);
    expect(lastMailTo('ada@ethz.ch')?.subject).toBe('@bob commented on “Attention Is All You Need”');

    const mention = await postComment({ paperId, account: bob.account, body: 'What do you think, @ada?' });
    expect(await mailCommentFollowers(mention.id)).toBe(0);
  });

  it('carries a one-click unsubscribe that turns follow mail off, and refuses a forged token', async () => {
    const paperId = await paper();
    const ada = await person('ada');
    const bob = await person('bob');
    await api('POST', '/follows', { cookie: ada.cookie, body: { paper: PAPER } });

    const comment = await postComment({ paperId, account: bob.account, body: 'Nice result.' });
    expect(await mailCommentFollowers(comment.id)).toBe(1);
    const headers = lastMailTo('ada@ethz.ch')?.headers ?? {};
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const token = new URL(/^<(.+)>$/.exec(headers['List-Unsubscribe'] ?? '')![1]).searchParams.get('token')!;
    expect(readUnsubscribeToken(token)).toEqual({ accountId: ada.account.id, kind: 'follow' });

    expect(await unsubscribe(token.replace(/^follow\./, 'mention.'))).toBe(false);
    expect(await unsubscribe(`follow.${bob.account.id}.${token.split('.')[2]}`)).toBe(false);
    expect(await unsubscribe(token)).toBe(true);
    const [row] = await getDb().select().from(accounts).where(eq(accounts.id, ada.account.id));
    expect(row.followMail).toBe(false);
    expect(row.mentionMail).toBe(true);
  });
});
