import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, pageRedirects, pages } from '@/db/schema';
import type { PaperId } from '@/lib/paper-ids';
import { DEFAULT_SHOWN } from '@/lib/user-pages';
import { decideClaim } from '@/server/claims';
import { commitPage } from '@/server/pages/commit';
import { findKeyedPage, findPage } from '@/server/pages/kinds';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { readPageForPlugins } from '@/server/plugins/pages';
import { saveSiteSettings } from '@/server/settings';
import { linkedAuthors, userPageView } from '@/server/user-pages';
import { api, closePool, commitFiles, resetDatabase, signUp } from './helpers';

/**
 * A person's page (`handoffs/pages.md` Phase 3): made with the account, moved with its handle, and showing only what
 * the account chose (DESIGN.md §5.3), the same to the page, the plugins and the public routes.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;
const OTHER = { scheme: 'arxiv', value: '2006.16236' } as const;

function paper(id: PaperId, authors = ['Ada Lovelace', 'Charles Babbage']) {
  return savePaper({
    title: `Paper ${id.value}`,
    authors,
    abstract: null,
    year: 2024,
    venue: null,
    identifiers: [id],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

/** A verified account with its handle chosen. */
async function person(handle: string, extra: Record<string, unknown> = {}) {
  const cookie = await signUp(`${handle}@ethz.ch`);
  const done = await api('PATCH', '/me', { cookie, body: { handle, showInstitution: false, ...extra } });
  expect(done.status).toBe(200);
  const [account] = await getDb().select().from(accounts).where(eq(accounts.handle, handle));
  return { cookie, account, actor: { kind: 'account', accountId: account.id, isAdmin: false } as const };
}

async function userPage(handle: string) {
  const page = await findKeyedPage(getDb(), 'user', handle);
  if (!page) throw new Error(`no page for @${handle}`);
  return page;
}

async function confirmClaim(cookie: string, paperId: string, authorIndex: number) {
  expect((await api('POST', '/claims', { cookie, body: { paper: PAPER, authorIndex } })).status).toBe(201);
  const [row] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
  await decideClaim(row.id, 'confirmed', null);
}

// The institution is the profile's `showInstitution`, not a setting (`handoffs/pages.md` Phase 4).
const showAll =
  '{ "user.show.realName": true, "user.show.claimedPapers": true, "user.show.activity": true, "user.show.comments": true }';

describe('user pages', () => {
  it('makes a page with every account, with no repo, moved with its handle', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const [placeholder] = await getDb().select().from(accounts);
    const first = await userPage(placeholder.handle);
    expect(await readHead(getDb(), first.id)).toBeNull();

    expect((await api('PATCH', '/me', { cookie, body: { handle: 'ada', showInstitution: false } })).status).toBe(200);
    const moved = await userPage('ada');
    expect(moved.id).toBe(first.id);
    expect(await findKeyedPage(getDb(), 'user', placeholder.handle)).toBeNull();
    // The old address still finds it, by identifier.
    expect((await findPage(`user:${placeholder.handle}`))?.id).toBe(first.id);

    // Moving again leaves both old addresses leading to the page, until someone else takes one of them.
    expect((await api('PATCH', '/me', { cookie, body: { handle: 'ada-l' } })).status).toBe(200);
    expect((await findPage('user:ada'))?.id).toBe(first.id);
    const bob = await person('bob');
    expect((await api('PATCH', '/me', { cookie: bob.cookie, body: { handle: 'ada' } })).status).toBe(200);
    expect((await findPage('user:ada'))?.id).toBe((await userPage('ada')).id);
    expect((await userPage('ada')).id).not.toBe(first.id);
    expect((await findPage(`user:${placeholder.handle}`))?.id).toBe(first.id);
    expect(await getDb().select().from(pageRedirects).where(eq(pageRedirects.key, 'ada'))).toEqual([]);

    // Deleting an account deletes its page and the redirects to it.
    await getDb().delete(accounts).where(eq(accounts.handle, 'ada-l'));
    expect(
      await getDb()
        .select()
        .from(pages)
        .where(and(eq(pages.kind, 'user'), eq(pages.id, first.id))),
    ).toEqual([]);
    expect(await findPage(`user:${placeholder.handle}`)).toBeNull();
  });

  it('shows by default no real name or institution, and the papers authored (DESIGN.md §5.3)', async () => {
    const paperId = await paper(PAPER);
    await paper(OTHER);
    const ada = await person('ada', { realName: 'Ada Lovelace' });
    await confirmClaim(ada.cookie, paperId, 0);
    const view = (await userPageView(await userPage('ada')))!;
    expect(view).toMatchObject({
      handle: 'ada',
      shown: DEFAULT_SHOWN,
      realName: null,
      institutions: null,
      claimedPapers: [{ page: { identifier: 'arxiv:1706.03762' }, authorName: 'Ada Lovelace' }],
      activity: [],
      comments: [],
    });
    // Plugins and the public routes see the same: no real name from the profile, no institution.
    const read = await readPageForPlugins('user:ada');
    expect(read.kindFile).toMatchObject({ show: DEFAULT_SHOWN });
    const route = await api('GET', `/pages/${encodeURIComponent('user:ada')}/files`);
    expect(route.status).toBe(200);
    expect(JSON.stringify(route.body)).not.toMatch(/ETH/);
    // The paper links her printed name to her page, until she turns that off.
    expect(await linkedAuthors(paperId)).toEqual([{ authorIndex: 0, authorName: 'Ada Lovelace', href: '/u/ada' }]);
    const off = '{ "user.show.claimedPapers": false }';
    expect((await api('PUT', '/me/settings', { cookie: ada.cookie, text: off })).status).toBe(200);
    expect(await linkedAuthors(paperId)).toEqual([{ authorIndex: 0, authorName: 'Ada Lovelace', href: null }]);
    expect((await userPageView(await userPage('ada')))!.claimedPapers).toBeNull();
  });

  it('shows what the account turns on in its settings', async () => {
    const paperId = await paper(PAPER);
    const ada = await person('ada', { realName: 'Ada Lovelace' });
    await confirmClaim(ada.cookie, paperId, 0);
    const page = await userPage('ada');

    expect((await api('PUT', '/me/settings', { cookie: ada.cookie, text: showAll })).status).toBe(200);
    expect((await api('PATCH', '/me', { cookie: ada.cookie, body: { showInstitution: true } })).status).toBe(200);
    const view = (await userPageView(page))!;
    expect(view.realName).toBe('Ada Lovelace');
    expect(view.institutions).toEqual(['ETH Zurich']);
    expect(view.claimedPapers).toMatchObject([
      { page: { identifier: 'arxiv:1706.03762' }, authorName: 'Ada Lovelace' },
    ]);
    expect((await readPageForPlugins('user:ada')).kindFile).toMatchObject({
      realName: 'Ada Lovelace',
      institutions: ['ETH Zurich'],
      papers: [{ identifier: 'arxiv:1706.03762', authorName: 'Ada Lovelace' }],
    });

    // Turned off again: gone from the page.
    const off = '{ "user.show.claimedPapers": false }';
    expect((await api('PUT', '/me/settings', { cookie: ada.cookie, text: off })).status).toBe(200);
    expect((await api('PATCH', '/me', { cookie: ada.cookie, body: { showInstitution: false } })).status).toBe(200);
    expect((await userPageView(page))!).toMatchObject({ realName: null, claimedPapers: null });

    // An admin can't publish everyone's names by setting a default.
    await saveSiteSettings('{ "user.show.realName": true }');
    expect((await userPageView(page))!.realName).toBeNull();
    await saveSiteSettings('{}');
  });

  it('lists edits and comments under the handle, never those as an author or anonymous ones', async () => {
    const own = await paper(PAPER);
    await paper(OTHER, ['Someone Else']);
    const ada = await person('ada');
    const base = async (id: PaperId) => {
      const res = await api('GET', `/workspace?scheme=${id.scheme}&value=${id.value}`, { cookie: ada.cookie });
      return (res.body?.head as string | null) ?? null;
    };

    // Under the handle: a community edit on the paper before the claim, a link on another paper.
    expect(
      (
        await commitFiles(
          ada.cookie,
          PAPER,
          await base(PAPER),
          { 'community/10-notes.md': '# Notes\n\nBefore.\n' },
          'Notes',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await commitFiles(
          ada.cookie,
          OTHER,
          await base(OTHER),
          { 'community/links.jsonl': '{"id":"a","to":"arxiv:1706.03762","label":"extends"}\n' },
          'Link',
        )
      ).status,
    ).toBe(200);
    expect(
      (await api('POST', '/comments', { cookie: ada.cookie, body: { paper: OTHER, body: 'Signed **here**.' } })).status,
    ).toBe(201);
    expect(
      (await api('POST', '/comments', { cookie: ada.cookie, body: { paper: OTHER, body: 'Hidden', anonymous: true } }))
        .status,
    ).toBe(201);
    expect(
      (await api('POST', '/comments', { cookie: ada.cookie, body: { paper: PAPER, body: 'Mine, before' } })).status,
    ).toBe(201);

    // As an author of their own paper: under their name there, so never on their page.
    await confirmClaim(ada.cookie, own, 0);
    expect(
      (
        await commitFiles(
          ada.cookie,
          PAPER,
          await base(PAPER),
          { 'owners/10-summary.md': '# Summary\n\nOurs.\n' },
          'Summary',
        )
      ).status,
    ).toBe(200);
    expect(
      (await api('POST', '/comments', { cookie: ada.cookie, body: { paper: PAPER, body: 'As the author' } })).status,
    ).toBe(201);

    const view = (await userPageView(await userPage('ada')))!;
    expect(view.activity!.map((item) => [item.page.identifier, item.summary, item.links])).toEqual([
      ['arxiv:2006.16236', 'Link', true],
      ['arxiv:1706.03762', 'Notes', false],
    ]);
    // A comment on the paper they now author carries their name there, so it isn't listed either.
    expect(view.comments!.map((c) => c.excerpt)).toEqual(['Signed here.']);

    // Turned off: not given at all.
    await api('PUT', '/me/settings', {
      cookie: ada.cookie,
      text: '{ "user.show.activity": false, "user.show.comments": false }',
    });
    expect((await userPageView(await userPage('ada')))!).toMatchObject({ activity: null, comments: null });
  });

  it('has no files: its bio and links are the account’s, and nobody commits to it', async () => {
    const ada = await person('ada');
    const page = await userPage('ada');
    const saved = await api('PATCH', '/me', {
      cookie: ada.cookie,
      body: { bio: 'I work on *engines*.', homepage: 'https://ada.example.org/', orcid: '0000-0002-1825-0097' },
    });
    expect(saved.body).toMatchObject({ homepage: 'https://ada.example.org/', orcid: '0000-0002-1825-0097' });
    expect((await api('PATCH', '/me', { cookie: ada.cookie, body: { orcid: 'nope' } })).body.error.code).toBe(
      'invalid_link',
    );
    expect((await userPageView(page))!).toMatchObject({
      bio: 'I work on *engines*.',
      links: { homepage: 'https://ada.example.org/', orcid: '0000-0002-1825-0097', scholar: null },
    });
    expect((await readPageForPlugins('user:ada')).kindFile).toMatchObject({ homepage: 'https://ada.example.org/' });
    await expect(
      commitPage(page.id, null, ada.actor, [{ path: 'owners/10-me.md', content: '# About\n\nMe.\n' }], 'About me'),
    ).rejects.toMatchObject({ status: expect.any(Number) });
    expect(await readHead(getDb(), page.id)).toBeNull();
  });
});
