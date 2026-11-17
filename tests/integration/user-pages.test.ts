import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, pageRedirects, pages } from '@/db/schema';
import type { PaperId } from '@/lib/paper-ids';
import { DEFAULT_SHOWN } from '@/lib/user-pages';
import { decideClaim } from '@/server/claims';
import { CONSUMERS } from '@/server/consumers';
import { runConsumer } from '@/server/consumers/run';
import { linksFrom, linksTo } from '@/server/page-links';
import { commitPage } from '@/server/pages/commit';
import { findKeyedPage, findPage } from '@/server/pages/kinds';
import { readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { readPageForPlugins } from '@/server/plugins/pages';
import { saveSiteSettings } from '@/server/settings';
import { userPageView } from '@/server/user-pages';
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

async function files(pageId: string): Promise<Record<string, string>> {
  const head = await readHead(getDb(), pageId);
  const commit = await readCommit(getDb(), pageId, head!);
  const out: Record<string, string> = {};
  for (const [path, blob] of await readFiles(getDb(), pageId, commit.tree)) {
    out[path] = (await readText(getDb(), pageId, blob)) ?? '';
  }
  return out;
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
  it('makes a page with every account, with its repo and profile.json, moved with its handle', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const [placeholder] = await getDb().select().from(accounts);
    const first = await userPage(placeholder.handle);
    expect(JSON.parse((await files(first.id))['profile.json'])).toEqual({ show: DEFAULT_SHOWN });

    expect((await api('PATCH', '/me', { cookie, body: { handle: 'ada', showInstitution: false } })).status).toBe(200);
    const moved = await userPage('ada');
    expect(moved.id).toBe(first.id);
    expect(await findKeyedPage(getDb(), 'user', placeholder.handle)).toBeNull();
    // The old address still finds it, by identifier, and the page's metadata says its new key.
    expect((await findPage(`user:${placeholder.handle}`))?.id).toBe(first.id);
    expect(JSON.parse((await files(first.id))['.potentialpaper/metadata.json'])).toMatchObject({
      kind: 'user',
      key: 'ada',
    });

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

  it('shows by default only what ties nothing to a name or an author identity (DESIGN.md §5.3)', async () => {
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
      claimedPapers: null,
      activity: [],
      comments: [],
    });
    // Plugins and the public routes see the same: no name, no institution, no papers.
    const read = await readPageForPlugins('user:ada');
    expect(read.kindFile).toEqual({ show: DEFAULT_SHOWN });
    const route = await api('GET', `/pages/${encodeURIComponent('user:ada')}/files`);
    expect(route.status).toBe(200);
    expect(JSON.stringify(route.body)).not.toMatch(/Lovelace|ETH|1706\.03762/);
  });

  it('shows what the account turns on in its settings, and profile.json follows', async () => {
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
    expect(JSON.parse((await files(page.id))['profile.json']).show).toMatchObject({
      realName: true,
      institution: true,
      claimedPapers: true,
    });
    expect((await readPageForPlugins('user:ada')).kindFile).toMatchObject({
      realName: 'Ada Lovelace',
      institutions: ['ETH Zurich'],
      papers: [{ identifier: 'arxiv:1706.03762', authorName: 'Ada Lovelace' }],
    });

    // Turned off again: gone from the page, and the file says so; the name was never in a commit.
    expect((await api('PUT', '/me/settings', { cookie: ada.cookie, text: '{}' })).status).toBe(200);
    expect((await api('PATCH', '/me', { cookie: ada.cookie, body: { showInstitution: false } })).status).toBe(200);
    expect((await userPageView(page))!).toMatchObject({ realName: null, claimedPapers: null });
    const show = JSON.parse((await files(page.id))['profile.json']).show;
    expect(show).toEqual(DEFAULT_SHOWN);
    expect(Object.values(await files(page.id)).join('\n')).not.toContain('Lovelace');

    // The account writes about/ and its links, but profile.json only through its settings.
    await expect(
      commitPage(
        page.id,
        await readHead(getDb(), page.id),
        ada.actor,
        [{ path: 'profile.json', content: '{}\n' }],
        'x',
      ),
    ).rejects.toMatchObject({ status: 403 });

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
          { 'author/10-summary.md': '# Summary\n\nOurs.\n' },
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

  it('links to the person elsewhere and to their work, from their own about/', async () => {
    await paper(PAPER);
    const ada = await person('ada');
    const page = await userPage('ada');
    const links = [
      '{"id":"h","to":"https://ada.example.org/","label":"homepage"}',
      '{"id":"o","to":"https://orcid.org/0000-0002-1825-0097","label":"orcid"}',
      '{"id":"w","to":"arxiv:1706.03762","label":"wrote"}',
    ].join('\n');
    expect(
      (
        await commitPage(
          page.id,
          await readHead(getDb(), page.id),
          ada.actor,
          [
            { path: 'about/10-me.md', content: '# About\n\nI work on engines.\n' },
            { path: 'about/links.jsonl', content: `${links}\n` },
          ],
          'About me',
        )
      ).status,
    ).toBe('committed');
    const consumer = CONSUMERS.find((c) => c.name === 'links')!;
    await runConsumer(consumer, { retryNow: true });
    const from = await linksFrom(page.id);
    expect(from.map((link) => [link.label, link.page.url ?? link.page.address])).toEqual([
      ['homepage', 'https://ada.example.org/'],
      ['orcid', 'https://orcid.org/0000-0002-1825-0097'],
      ['wrote', { kind: 'paper', id: PAPER }],
    ]);
    const paperPage = await findPage('arxiv:1706.03762');
    expect((await linksTo(paperPage!.id)).map((link) => [link.label, link.page.name])).toEqual([['wrote', '@ada']]);
    expect((await readPageForPlugins('user:ada')).links.map((link) => link.to)).toEqual([
      'https://ada.example.org/',
      'https://orcid.org/0000-0002-1825-0097',
      'arxiv:1706.03762',
    ]);
  });
});
