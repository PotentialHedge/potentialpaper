import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { authorClaims, commentMentions } from '@/db/schema';
import { decideClaim } from '@/server/claims';
import { devOutbox } from '@/server/mail';
import { mailMentions } from '@/server/mentions';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, lastMailTo, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;
const LIST = `/comments?scheme=arxiv&value=1706.03762`;

function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani', 'Noam Shazeer'],
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

/** A verified account with its handle chosen. */
async function person(handle: string): Promise<string> {
  const cookie = await signUp(`${handle}@ethz.ch`);
  const done = await api('PATCH', '/me', { cookie, body: { handle, showInstitution: true } });
  expect(done.status).toBe(200);
  return cookie;
}

const post = (cookie: string, body: string, extra: Record<string, unknown> = {}) =>
  api('POST', '/comments', { cookie, body: { paper: PAPER, body, ...extra } });

describe('comments', () => {
  it('posts, renders Markdown and math safely, and lists newest first', async () => {
    await paper();
    const ada = await person('ada');
    const first = await post(ada, 'First, with $x^2$ and <script>alert(1)</script> and [a](javascript:alert(1)).');
    expect(first.status).toBe(201);
    expect(first.body.author).toMatchObject({
      kind: 'account',
      handle: 'ada',
      institutions: ['ETH Zurich'],
      isYou: true,
    });
    expect(first.body.html).toContain('class="katex"');
    expect(first.body.html).not.toMatch(/<script|href="javascript/);
    await post(ada, '# Heading\n\n![x](https://example.org/a.png) ![g](https://media.giphy.com/media/x/giphy.gif)');

    const visitor = await api('GET', LIST);
    expect(visitor.status).toBe(200);
    expect(visitor.body.total).toBe(2);
    expect(visitor.body.viewer).toBeNull();
    const [newest] = visitor.body.comments;
    expect(newest.author.isYou).toBe(false);
    expect(newest.html).toContain('<p class="comment-heading"><strong>Heading</strong></p>');
    expect(newest.html).toContain('<img src="https://media.giphy.com/media/x/giphy.gif"');
    expect(newest.html).toContain('<a href="https://example.org/a.png"');
    expect(newest.html).not.toContain('<img src="https://example.org');
  });

  it('refuses visitors and unverified writes, and needs a known paper', async () => {
    await paper();
    expect((await api('POST', '/comments', { body: { paper: PAPER, body: 'hi' } })).status).toBe(401);
    const ada = await person('ada');
    const missing = await api('POST', '/comments', {
      cookie: ada,
      body: { paper: { scheme: 'arxiv', value: '2401.00001' }, body: 'hi' },
    });
    expect(missing.status).toBe(404);
  });

  it('anonymous comments share one alias per paper, and mentions resolve to aliases and handles', async () => {
    await paper();
    const ada = await person('ada');
    const bob = await person('bob');
    const a1 = await post(ada, 'Anonymous one.', { anonymous: true });
    const a2 = await post(ada, 'Anonymous two.', { anonymous: true });
    expect(a1.body.author.kind).toBe('alias');
    expect(a2.body.author.alias).toBe(a1.body.author.alias);
    // The handle as a JSON value: the id (hex) and the alias (four characters) can contain "ada" by chance.
    expect(JSON.stringify(a1.body)).not.toContain('"ada"');
    const alias = a1.body.author.alias as string;

    const reply = await post(bob, `@${alias} and @ada, but not @nobody or \`@ada\`.`, { parentId: a1.body.id });
    expect(reply.status).toBe(201);
    expect(reply.body.mentions).toEqual([alias, 'ada']);
    expect(reply.body.html).toContain(`<span class="mention" data-mention="${alias}">@${alias}</span>`);
    expect(reply.body.html).not.toContain('data-mention="nobody"');
    expect(reply.body.html).toContain('<code>@ada</code>');

    // Ada's view sets her own names apart.
    const seen = await api('GET', LIST, { cookie: ada });
    expect(seen.body.viewer).toMatchObject({ canComment: true, handle: 'ada', alias, authorName: null });
    const shownReply = seen.body.replies.find((r: { id: string }) => r.id === reply.body.id);
    expect(shownReply.html).toContain('mention mention-you');

    // One row for Ada, however she was named.
    const rows = await getDb().select().from(commentMentions).where(eq(commentMentions.commentId, reply.body.id));
    expect(rows).toHaveLength(1);

    const inbox = await api('GET', '/me/mentions', { cookie: ada });
    expect(inbox.body.mentions).toHaveLength(1);
    expect(inbox.body.mentions[0].paper).toEqual({
      title: 'Attention Is All You Need',
      path: '/abs/1706.03762#discussion',
    });
    expect(await mailMentions(reply.body.id)).toBe(1);
    expect(lastMailTo('ada@ethz.ch')?.subject).toBe('@bob mentioned you on “Attention Is All You Need”');

    // Turned off, nothing is mailed.
    await api('PATCH', '/me', { cookie: ada, body: { mentionMail: false } });
    const before = devOutbox().length;
    const again = await post(bob, 'Again, @ada.');
    expect(await mailMentions(again.body.id)).toBe(0);
    expect(devOutbox().length).toBe(before);
  });

  it("shows a confirmed author by their name on the paper, never their handle, and won't let them hide it", async () => {
    const paperId = await paper();
    const ashish = await person('ashish');
    const before = await post(ashish, 'Posted before the claim.');
    await api('POST', '/claims', { cookie: ashish, body: { paper: PAPER, authorIndex: 0 } });
    const [row] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
    await decideClaim(row.id, 'confirmed', null);

    expect((await post(ashish, 'Hidden?', { anonymous: true })).status).toBe(403);
    const named = await post(ashish, 'As an author.');
    expect(named.body.author).toEqual({ kind: 'author', name: 'Ashish Vaswani', isYou: true });
    const list = await api('GET', LIST);
    expect(JSON.stringify(list.body)).not.toContain('ashish');
    expect(list.body.comments.find((c: { id: string }) => c.id === before.body.id).author.kind).toBe('author');
    expect((await api('GET', LIST, { cookie: ashish })).body.viewer.authorName).toBe('Ashish Vaswani');
  });

  it('nests replies, pages them, and keeps a removed comment in its place', async () => {
    await paper();
    const ada = await person('ada');
    const bob = await person('bob');
    const top = await post(ada, 'Top.');
    const replies = [];
    for (let i = 0; i < 5; i += 1) replies.push((await post(bob, `Reply ${i}.`, { parentId: top.body.id })).body);
    await post(ada, 'Deep.', { parentId: replies[0].id });

    const list = await api('GET', LIST);
    expect(list.body.comments).toHaveLength(1);
    expect(list.body.comments[0].replyCount).toBe(5);
    // Three replies to the top, and the one under the first: flat, oldest first.
    expect(list.body.replies.map((r: { body: string }) => r.body)).toEqual([
      'Reply 0.',
      'Reply 1.',
      'Reply 2.',
      'Deep.',
    ]);

    const rest = await api('GET', `/comments/${top.body.id}/replies?after=${replies[2].id}`);
    expect(rest.body.replies.map((r: { body: string }) => r.body)).toEqual(['Reply 3.', 'Reply 4.']);

    expect((await api('DELETE', `/comments/${top.body.id}`, { cookie: bob })).status).toBe(404);
    expect((await api('DELETE', `/comments/${top.body.id}`, { cookie: ada })).status).toBe(200);
    const after = await api('GET', LIST);
    expect(after.body.comments[0]).toMatchObject({ removed: true, body: null, html: null, replyCount: 5 });
    expect(after.body.total).toBe(6);
  });

  it('pages top-level comments with a cursor', async () => {
    await paper();
    const ada = await person('ada');
    for (let i = 0; i < 3; i += 1) await post(ada, `C${i}`);
    const first = await api('GET', `${LIST}&limit=2`);
    expect(first.body.comments.map((c: { body: string }) => c.body)).toEqual(['C2', 'C1']);
    const next = await api('GET', `${LIST}&limit=2&cursor=${first.body.nextCursor}`);
    expect(next.body.comments.map((c: { body: string }) => c.body)).toEqual(['C0']);
    expect(next.body.nextCursor).toBeNull();
  });

  it('previews a draft with its mentions resolved', async () => {
    await paper();
    const ada = await person('ada');
    const res = await api('POST', '/comments/preview', { cookie: ada, body: { paper: PAPER, body: 'Hi @ada, $a$' } });
    expect(res.status).toBe(200);
    expect(res.body.mentions).toEqual(['ada']);
    expect(res.body.html).toContain('data-mention="ada"');
  });

  it('records the page head a comment was written against, and counts the edits since', async () => {
    const paperId = await paper();
    const ada = await person('ada');
    const edit = async (n: number) =>
      commitPage(
        paperId,
        await readHead(getDb(), paperId),
        SYSTEM_ACTOR,
        [{ path: '.potentialpaper/metadata.json', content: `{"title":"T${n}"}\n` }],
        `Edit ${n}`,
      );
    await edit(1);
    const head = await readHead(getDb(), paperId);
    const posted = await post(ada, 'About this version.');
    expect(posted.body).toMatchObject({ pageCommit: head, editsSince: 0 });

    await edit(2);
    await edit(3);
    const later = await post(ada, 'About the newest.');
    const list = await api('GET', LIST);
    const byId = new Map(list.body.comments.map((c: { id: string }) => [c.id, c]));
    expect(byId.get(posted.body.id)).toMatchObject({ pageCommit: head, editsSince: 2 });
    expect(byId.get(later.body.id)).toMatchObject({ editsSince: 0 });
  });
});
