import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims, orgMembersDue, pageCurrent, pageMembers, pdfDocuments } from '@/db/schema';
import { ensureBot, grantBot } from '@/server/bots';
import { decideClaim } from '@/server/claims';
import { rebuildConsumer, runConsumer } from '@/server/consumers/run';
import { orgOverview, ORGS_BOT, orgFileUpdate, syncOrgPages } from '@/server/org-pages';
import { membersConsumer, scopeMembers, syncDueAffiliations } from '@/server/page-members';
import { commitPage, createPage } from '@/server/pages/commit';
import { findKeyedPage } from '@/server/pages/kinds';
import { readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { pageMembersForPlugins } from '@/server/plugins/pages';
import { userPageView } from '@/server/user-pages';
import { api, closePool, resetDatabase, signUp } from './helpers';

/**
 * Organisation pages (`handoffs/pages.md` Phase 4): the `orgs` bot, an org's papers through its members' claims and
 * the addresses printed on page 1, rolled up from its departments, who its members are and what they may write, and
 * the people it lists (only those who show their institution).
 */

beforeEach(resetDatabase);
afterAll(closePool);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

function paper(arxiv: string = PAPER.value, authors = ['Ada Lovelace', 'Charles Babbage']) {
  return savePaper({
    title: `Paper ${arxiv}`,
    authors,
    abstract: null,
    year: 2027,
    venue: null,
    identifiers: [{ scheme: 'arxiv', value: arxiv }],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

async function grantOrgsBot() {
  await ensureBot(ORGS_BOT);
  await grantBot(ORGS_BOT, 'org.json', { grantedBy: 'system', kind: 'org' });
}

/** A verified account at `email`'s institution, its handle chosen, showing its institution or not. */
async function person(handle: string, email: string, showInstitution: boolean) {
  const cookie = await signUp(email);
  expect((await api('PATCH', '/me', { cookie, body: { handle, showInstitution } })).status).toBe(200);
  const [account] = await getDb().select().from(accounts).where(eq(accounts.handle, handle));
  return { cookie, account, actor: { kind: 'account', accountId: account.id, isAdmin: false } as const };
}

async function orgFile(key: string) {
  const page = await findKeyedPage(getDb(), 'org', key);
  if (!page) return null;
  const head = await readHead(getDb(), page.id);
  const commit = await readCommit(getDb(), page.id, head!);
  const blob = (await readFiles(getDb(), page.id, commit.tree)).get('org.json');
  return blob ? JSON.parse((await readText(getDb(), page.id, blob))!) : null;
}

/** Every consumer and task that membership takes, until nothing is left. */
async function catchUp() {
  await syncDueAffiliations();
  expect(await runConsumer(membersConsumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
  await syncDueAffiliations();
}

async function papersOf(key: string, rollUp = true) {
  const page = await findKeyedPage(getDb(), 'org', key);
  return (await scopeMembers(page!.id, { rollUp })).map((m) => m.paperId).sort();
}

async function confirmClaim(cookie: string, authorIndex: number) {
  expect((await api('POST', '/claims', { cookie, body: { paper: PAPER, authorIndex } })).status).toBe(201);
  const [row] = await getDb()
    .select()
    .from(authorClaims)
    .where(and(eq(authorClaims.authorIndex, authorIndex), eq(authorClaims.status, 'pending')));
  await decideClaim(row.id, 'confirmed', null);
}

/** Puts a PDF with these addresses on page 1 on the paper, as the ingest pipeline leaves it. */
async function printAddresses(paperId: string, emails: string[]) {
  const actor = (await person(`editor-${paperId.slice(0, 6)}`, `editor-${paperId.slice(0, 6)}@mit.edu`, false)).actor;
  if (!(await readHead(getDb(), paperId))) {
    await commitPage(paperId, null, actor, [{ path: 'community/10-notes.md', content: '# Notes\n\nHi.\n' }], 'Notes');
  }
  const sha256 = paperId.replace(/-/g, '').padEnd(64, '0');
  await getDb()
    .update(pageCurrent)
    .set({ pdf: { sha256, bytes: 1, url: `https://example.org/${sha256}.pdf` } as never })
    .where(eq(pageCurrent.pageId, paperId));
  await getDb()
    .insert(pdfDocuments)
    .values({ sha256, url: `https://example.org/${sha256}.pdf`, emails })
    .onConflictDoUpdate({ target: pdfDocuments.sha256, set: { emails } });
}

describe('the orgs bot', () => {
  it('makes a page per institution, with its domains and ROR id, and never rewrites what is there', async () => {
    await grantOrgsBot();
    expect(await syncOrgPages({ domains: ['inf.ethz.ch', 'nowhere.example'] })).toEqual({
      written: ['eth-zurich'],
      unknown: ['nowhere.example'],
    });
    expect(await orgFile('eth-zurich')).toEqual({
      name: 'ETH Zurich',
      domains: ['ethz.ch'],
      ror: 'https://ror.org/05a28rw58',
    });
    // A second run writes nothing.
    expect(await syncOrgPages({ domains: ['ethz.ch'] })).toEqual({ written: [], unknown: [] });

    // Someone renamed it and dropped the ROR id: the bot adds the id back, and keeps the name.
    expect(
      orgFileUpdate(
        { name: 'ETH', domains: ['ethz.ch'] },
        { name: 'ETH Zurich', domains: ['ethz.ch'], ror: 'https://ror.org/05a28rw58' },
      ),
    ).toEqual({
      name: 'ETH',
      domains: ['ethz.ch'],
      ror: 'https://ror.org/05a28rw58',
    });
    expect(orgFileUpdate('not an org', { name: 'X' })).toBeNull();

    // A key another organisation's page has already: the institution takes its next one.
    await createPage('org', 'massachusetts-institute-of-technology');
    expect((await syncOrgPages({ domains: ['mit.edu'] })).written).toEqual(['mit']);
    expect((await orgFile('mit'))?.name).toBe('Massachusetts Institute of Technology');
  });

  it("makes the institutions in use, and a new member's on sign-up, only once granted", async () => {
    await signUp('ada@ethz.ch');
    expect(await findKeyedPage(getDb(), 'org', 'eth-zurich')).toBeNull();
    await expect(syncOrgPages()).rejects.toMatchObject({ status: 403 });

    await grantOrgsBot();
    expect((await syncOrgPages()).written).toEqual(['eth-zurich']);
    await signUp('bob@mit.edu');
    expect(await orgFile('massachusetts-institute-of-technology')).toMatchObject({ domains: ['mit.edu'] });
  });
});

describe('an org', () => {
  it("has its members' claimed papers when they show their institution, and the papers that print its domain", async () => {
    await grantOrgsBot();
    const paperId = await paper();
    const ada = await person('ada', 'ada@ethz.ch', true);
    const bob = await person('bob', 'bob@ethz.ch', false);
    await catchUp();
    expect(await papersOf('eth-zurich')).toEqual([]);

    // Bob is an author but doesn't show his institution: the paper isn't ETH's through him.
    await confirmClaim(bob.cookie, 1);
    await catchUp();
    expect(await papersOf('eth-zurich')).toEqual([]);

    // Ada shows hers: it is.
    await confirmClaim(ada.cookie, 0);
    await catchUp();
    expect(await papersOf('eth-zurich')).toEqual([paperId]);
    const eth = (await findKeyedPage(getDb(), 'org', 'eth-zurich'))!;
    const [row] = await getDb().select().from(pageMembers).where(eq(pageMembers.scopePageId, eth.id));
    expect(row).toMatchObject({ via: 'affiliation', weight: 1 });
    // Nothing public says it came from a claim.
    expect(
      (await pageMembersForPlugins('org:eth-zurich', { offset: 0, limit: 50, rollUp: true })).papers,
    ).toMatchObject([{ identifier: 'arxiv:1706.03762', via: ['affiliation'] }]);

    // She stops showing it: gone again.
    expect((await api('PATCH', '/me', { cookie: ada.cookie, body: { showInstitution: false } })).status).toBe(200);
    expect(await getDb().select().from(orgMembersDue)).toEqual([{ paperId, markedAt: expect.any(Date) }]);
    await catchUp();
    expect(await papersOf('eth-zurich')).toEqual([]);

    // An address at a department's subdomain on page 1 makes it ETH's, as likely, not certain.
    await printAddresses(paperId, ['someone@inf.ethz.ch', 'other@gmail.com']);
    await catchUp();
    expect(await papersOf('eth-zurich')).toEqual([paperId]);
    const [printed] = await getDb().select().from(pageMembers).where(eq(pageMembers.scopePageId, eth.id));
    expect(printed).toMatchObject({ via: 'affiliation', weight: 0.5 });
  });

  it('rolls up from its departments, whose domains are under its own, and rebuilds the same', async () => {
    await grantOrgsBot();
    const ada = await person('ada', 'ada@ethz.ch', true);
    const lab = await paper('2401.00001');
    const elsewhere = await paper('2401.00002');
    await printAddresses(lab, ['x@inf.ethz.ch']);
    await printAddresses(elsewhere, ['y@mit.edu']);

    // Ada is a member: she adds a department, with a domain under ETH's.
    const made = await api('POST', `/pages/${encodeURIComponent('org:eth-zurich')}/children`, {
      cookie: ada.cookie,
      body: { slug: 'inf', name: 'Department of Computer Science', domains: ['inf.ethz.ch'] },
    });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ identifier: 'org:eth-zurich/inf', name: 'Department of Computer Science' });
    // Not with another institution's domain, and not by someone who isn't a member.
    expect(
      (
        await api('POST', `/pages/${encodeURIComponent('org:eth-zurich')}/children`, {
          cookie: ada.cookie,
          body: { slug: 'csail', name: 'CSAIL', domains: ['csail.mit.edu'] },
        })
      ).status,
    ).toBe(422);
    expect(await findKeyedPage(getDb(), 'org', 'eth-zurich/csail')).toBeNull();
    const bob = await person('bob', 'bob@mit.edu', true);
    expect(
      (
        await api('POST', `/pages/${encodeURIComponent('org:eth-zurich')}/children`, {
          cookie: bob.cookie,
          body: { slug: 'bob', name: 'Bob Lab' },
        })
      ).status,
    ).toBe(403);

    await catchUp();
    expect(await papersOf('eth-zurich/inf')).toEqual([lab]);
    expect(await papersOf('eth-zurich', false)).toEqual([lab]);
    expect(await papersOf('eth-zurich')).toEqual([lab]);
    expect(await papersOf('massachusetts-institute-of-technology')).toEqual([elsewhere]);

    const overview = await orgOverview((await findKeyedPage(getDb(), 'org', 'eth-zurich'))!);
    expect(overview.children).toEqual([{ key: 'eth-zurich/inf', name: 'Department of Computer Science', papers: 1 }]);
    expect(overview.people).toEqual({ handles: ['ada'], count: 1 });

    // A rebuild, with a paper that has a claim and no repo, gives the same rows.
    const norepo = await paper('2401.00003', ['Ada Lovelace']);
    expect(
      (
        await api('POST', '/claims', {
          cookie: ada.cookie,
          body: { paper: { scheme: 'arxiv', value: '2401.00003' }, authorIndex: 0 },
        })
      ).status,
    ).toBe(201);
    const [claim] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, norepo));
    await decideClaim(claim.id, 'confirmed', null);
    await catchUp();
    const before = await getDb().execute(sql`select * from page_members order by scope_page_id, paper_id, via`);
    expect(await papersOf('eth-zurich')).toEqual([lab, norepo].sort());
    await rebuildConsumer(membersConsumer);
    await catchUp();
    const after = await getDb().execute(sql`select * from page_members order by scope_page_id, paper_id, via`);
    expect(after.rows).toEqual(before.rows);
  });

  it('is written by its members, whose top-level domains only admins and the bot change', async () => {
    await grantOrgsBot();
    const ada = await person('ada', 'ada@ethz.ch', false);
    const bob = await person('bob', 'bob@mit.edu', true);
    const eth = (await findKeyedPage(getDb(), 'org', 'eth-zurich'))!;
    const head = async () => readHead(getDb(), eth.id);

    // A member writes members/ whether or not she shows her institution: it is her own act.
    expect(
      await commitPage(
        eth.id,
        await head(),
        ada.actor,
        [{ path: 'members/10-about.md', content: '# About\n\nUs.\n' }],
        'About',
      ),
    ).toMatchObject({ status: 'committed' });
    await expect(
      commitPage(
        eth.id,
        await head(),
        bob.actor,
        [{ path: 'members/10-about.md', content: '# About\n\nThem.\n' }],
        'x',
      ),
    ).rejects.toMatchObject({ status: 403 });
    // Anyone verified writes community/.
    expect(
      await commitPage(
        eth.id,
        await head(),
        bob.actor,
        [{ path: 'community/10-notes.md', content: '# Notes\n\nHi.\n' }],
        'Notes',
      ),
    ).toMatchObject({ status: 'committed' });

    // Ada may rename it, but not widen its domains.
    const file = (await orgFile('eth-zurich'))!;
    expect(
      await commitPage(
        eth.id,
        await head(),
        ada.actor,
        [{ path: 'org.json', content: `${JSON.stringify({ ...file, name: 'ETH Zürich' })}\n` }],
        'Name',
      ),
    ).toMatchObject({ status: 'committed' });
    await expect(
      commitPage(
        eth.id,
        await head(),
        ada.actor,
        [{ path: 'org.json', content: `${JSON.stringify({ ...file, domains: ['ethz.ch', 'mit.edu'] })}\n` }],
        'Grab',
      ),
    ).rejects.toMatchObject({ status: 403 });
    const admin = { kind: 'account', accountId: bob.account.id, isAdmin: true } as const;
    expect(
      await commitPage(
        eth.id,
        await head(),
        admin,
        [{ path: 'org.json', content: `${JSON.stringify({ ...file, domains: ['ethz.ch', 'ethz.org'] })}\n` }],
        'Add a domain',
      ),
    ).toMatchObject({ status: 'committed' });
  });

  it('lists as people only the members who show their institution', async () => {
    await grantOrgsBot();
    const ada = await person('ada', 'ada@ethz.ch', true);
    await person('bob', 'bob@ethz.ch', false);
    const eth = (await findKeyedPage(getDb(), 'org', 'eth-zurich'))!;
    await catchUp();
    expect((await orgOverview(eth)).people).toEqual({ handles: ['ada'], count: 1 });
    const route = await api('GET', `/pages/${encodeURIComponent('org:eth-zurich')}/org`);
    expect(route.status).toBe(200);
    expect(route.body).toMatchObject({ people: [{ handle: 'ada' }], peopleCount: 1, parent: null, children: [] });
    expect(JSON.stringify(route.body)).not.toContain('bob');

    // Her own page shows the institution by the same choice, and profile.json says so.
    const page = (await findKeyedPage(getDb(), 'user', 'ada'))!;
    expect((await userPageView(page))!.institutions).toEqual(['ETH Zurich']);
    expect((await api('PATCH', '/me', { cookie: ada.cookie, body: { showInstitution: false } })).status).toBe(200);
    expect((await userPageView(page))!.institutions).toBeNull();
    const head = await readHead(getDb(), page.id);
    const blob = (await readFiles(getDb(), page.id, (await readCommit(getDb(), page.id, head!)).tree)).get(
      'profile.json',
    );
    expect(JSON.parse((await readText(getDb(), page.id, blob!))!).show.institution).toBe(false);
    expect((await orgOverview(eth)).people).toEqual({ handles: [], count: 0 });
  });
});
