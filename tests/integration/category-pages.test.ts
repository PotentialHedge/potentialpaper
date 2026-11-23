import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageCurrent, submissions } from '@/db/schema';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { runConsumer } from '@/server/consumers/run';
import { submissionFiles } from '@/server/import-reviews';
import { reviewsConsumer } from '@/server/review-projection';
import { linksConsumer } from '@/server/page-links';
import { membersConsumer, scopeMembers } from '@/server/page-members';
import { commitPage } from '@/server/pages/commit';
import { findKeyedPage, findPage } from '@/server/pages/kinds';
import { readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, resetDatabase, signUp, submittedVersion } from './helpers';

/**
 * Category pages (`handoffs/pages.md` Phase 5), which work as Wikipedia's categories do: making one with its name checked
 * first, putting a page of any kind in one (and making it by name), a category in a category as a subcategory, the lists on the
 * category's page, editing, renaming and merging with redirects, page protection and the patrol feed.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const enc = encodeURIComponent;

async function person(handle: string, email = `${handle}@example.org`) {
  const cookie = await signUp(email);
  expect((await api('PATCH', '/me', { cookie, body: { handle, showInstitution: false } })).status).toBe(200);
  const [account] = await getDb().select().from(accounts).where(eq(accounts.handle, handle));
  return { cookie, account, actor: { kind: 'account', accountId: account.id, isAdmin: false } as const };
}

function paper(arxiv: string, title = `Paper ${arxiv}`, abstract: string | null = null, year = 2025) {
  return savePaper({
    title,
    authors: ['Ada Lovelace'],
    abstract,
    year,
    venue: null,
    identifiers: [{ scheme: 'arxiv', value: arxiv }],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

async function newCategory(cookie: string, body: Record<string, unknown>) {
  return api('POST', '/categories', { cookie, body });
}

async function addTo(cookie: string, page: string, body: Record<string, unknown>) {
  return api('POST', `/pages/${enc(page)}/categories`, { cookie, body });
}

async function catchUp() {
  for (const consumer of [linksConsumer, membersConsumer]) {
    expect(await runConsumer(consumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
  }
}

async function fileAt(pageId: string, path: string): Promise<string | null> {
  const head = await readHead(getDb(), pageId);
  if (!head) return null;
  const commit = await readCommit(getDb(), pageId, head);
  return readText(getDb(), pageId, (await readFiles(getDb(), pageId, commit.tree)).get(path));
}

async function categoryId(key: string) {
  return (await findKeyedPage(getDb(), 'category', key))!.id;
}

/** The papers of a category's scope, as its statistics count them. */
async function membersOf(key: string) {
  return (await scopeMembers(await categoryId(key), { rollUp: true })).map((m) => m.paperId).sort();
}

/** What the category page lists, by identifier. */
async function listed(key: string) {
  const res = await api('GET', `/pages/${enc(`category:${key}`)}/category`);
  expect(res.status).toBe(200);
  const ids = (list: { identifier: string }[]) => list.map((m) => m.identifier);
  return { subcategories: ids(res.body.subcategories), pages: ids(res.body.pages), body: res.body };
}

describe('making a category', () => {
  it('makes the page and its category.json, checks the name first, and refuses duplicates', async () => {
    const { cookie } = await person('ada');
    const made = await newCategory(cookie, {
      name: 'State-space models',
      summary: 'Sequence models with a linear recurrence.',
    });
    expect(made.status).toBe(201);
    expect(made.body.identifier).toBe('category:state-space-models');
    const page = await findKeyedPage(getDb(), 'category', 'state-space-models');
    expect(JSON.parse((await fileAt(page!.id, 'category.json'))!)).toEqual({ name: 'State-space models' });
    expect(await fileAt(page!.id, 'community/10-what-it-is.md')).toBe(
      '# What it is\n\nSequence models with a linear recurrence.\n',
    );

    // The same name, as duplicates are told: case, punctuation and plurals aside.
    const again = await newCategory(cookie, { name: 'state space model' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('category_exists');
    expect(again.body.error.details.identifier).toBe('category:state-space-models');
    // A taken address with another name.
    const taken = await newCategory(cookie, { name: 'Other', slug: 'state-space-models' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('page_exists');
    // category.json has a name and nothing else.
    expect((await newCategory(cookie, { name: 'Mamba', aliases: ['S6'] })).status).toBe(201);
    expect(JSON.parse((await fileAt(await categoryId('mamba'), 'category.json'))!)).toEqual({ name: 'Mamba' });

    // What the form shows as one types: the same name first, then similar ones.
    const found = await api('GET', `/categories?q=${enc('State space models')}`);
    expect(found.body.categories[0]).toMatchObject({ key: 'state-space-models', exact: true });
    const similar = await api('GET', `/categories?q=${enc('space model')}`);
    expect(similar.body.categories[0]).toMatchObject({ key: 'state-space-models', exact: false });
    // Misspelled, or part of the name misspelled.
    const misspelled = await api('GET', `/categories?q=${enc('stat spce')}`);
    expect(misspelled.body.categories[0]).toMatchObject({ key: 'state-space-models' });
  });

  it('needs a verified account', async () => {
    expect((await newCategory('', { name: 'Linear attention' })).status).toBe(401);
  });
});

describe('pages in a category', () => {
  it('puts a paper in a category by name, making the category, and lists it on the category page', async () => {
    const { cookie } = await person('ada');
    const a = await paper('2401.00001', 'Transformers are RNNs');
    const b = await paper('2401.00002', 'Gated linear attention');

    // By a name no category has: the category is made, under the name given.
    const first = await addTo(cookie, 'arxiv:2401.00001', { name: 'Linear attention' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      status: 'linked',
      category: { identifier: 'category:linear-attention' },
    });
    const line = JSON.parse((await fileAt(a, 'community/links.jsonl'))!.trim());
    expect(line).toMatchObject({ to: 'category:linear-attention', label: 'in-category' });
    expect(line.id).toMatch(/^[0-9A-Z]{26}$/);

    // By a name it has: linked, not made again; and a second time is nothing new.
    expect((await addTo(cookie, 'arxiv:2401.00002', { name: 'linear attention' })).body).toMatchObject({
      created: false,
      status: 'linked',
    });
    const again = await addTo(cookie, 'arxiv:2401.00002', { category: 'category:linear-attention' });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('exists');

    // Listed at once, before the worker indexes the commits: adding indexes the link itself.
    expect((await listed('linear-attention')).pages).toEqual(['arxiv:2401.00002', 'arxiv:2401.00001']);

    await catchUp();
    // Its pages, by name; the papers are its scope's too, for its statistics.
    expect((await listed('linear-attention')).pages).toEqual(['arxiv:2401.00002', 'arxiv:2401.00001']);
    expect(await membersOf('linear-attention')).toEqual([a, b].sort());
  });

  it('puts a category in a category as a subcategory, with nothing rolled up, and never in itself', async () => {
    const { cookie } = await person('ada');
    const a = await paper('2401.00003', 'Transformers are RNNs');
    expect((await newCategory(cookie, { name: 'Efficient transformers' })).status).toBe(201);
    expect((await addTo(cookie, 'arxiv:2401.00003', { name: 'Linear attention' })).status).toBe(201);

    const sub = await addTo(cookie, 'category:linear-attention', { category: 'category:efficient-transformers' });
    expect(sub.status).toBe(201);
    expect(await fileAt(await categoryId('linear-attention'), 'community/links.jsonl')).toContain(
      '"to":"category:efficient-transformers","label":"in-category"',
    );
    await catchUp();

    const above = await listed('efficient-transformers');
    expect(above.subcategories).toEqual(['category:linear-attention']);
    expect(above.pages).toEqual([]);
    expect(await membersOf('efficient-transformers')).toEqual([]);
    expect(await membersOf('linear-attention')).toEqual([a]);

    const self = await addTo(cookie, 'category:linear-attention', { category: 'category:linear-attention' });
    expect(self.status).toBe(422);
  });

  it("puts a confirmed author's category links in owners/", async () => {
    const author = await person('ada');
    const p = await paper('2401.00004');
    // The fixture's quickest way to an author: an admin's commit isn't one, so confirm a claim by hand.
    await getDb().execute(sql`
      insert into author_claims (paper_id, account_id, author_index, author_name, status, method, identity_id)
      values (${p}, ${author.account.id}, 0, 'Ada Lovelace', 'confirmed', 'manual', 'a_testtest')
    `);
    const linked = await addTo(author.cookie, 'arxiv:2401.00004', { name: 'Mixture of experts' });
    expect(linked.status).toBe(201);
    expect(await fileAt(p, 'owners/links.jsonl')).toContain('category:mixture-of-experts');
    expect(await fileAt(p, 'community/links.jsonl')).toBeNull();
  });
});

describe('renaming and merging', () => {
  it('renames with a redirect: old links and the address still find it', async () => {
    const { cookie } = await person('ada');
    const p = await paper('2403.00001');
    expect((await newCategory(cookie, { name: 'Linear attention' })).status).toBe(201);
    expect((await newCategory(cookie, { name: 'Gated linear attention' })).status).toBe(201);
    await addTo(cookie, 'category:gated-linear-attention', { category: 'category:linear-attention' });
    await addTo(cookie, 'arxiv:2403.00001', { category: 'category:linear-attention' });
    await catchUp();

    const renamed = await api('POST', `/pages/${enc('category:linear-attention')}/rename`, {
      cookie,
      body: { slug: 'linearised-attention', name: 'Linearised attention' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.identifier).toBe('category:linearised-attention');
    await catchUp();

    const page = await findPage('category:linear-attention');
    expect(page?.key).toBe('linearised-attention');
    expect(JSON.parse((await fileAt(page!.id, 'category.json'))!)).toEqual({ name: 'Linearised attention' });
    // The links still name category:linear-attention; they count.
    expect(await membersOf('linearised-attention')).toEqual([p]);
    const lists = await listed('linearised-attention');
    expect(lists.subcategories).toEqual(['category:gated-linear-attention']);
    expect(lists.pages).toEqual(['arxiv:2403.00001']);

    // A new category may take the old slug: the redirect gives way.
    expect((await newCategory(cookie, { name: 'Something new', slug: 'linear-attention' })).status).toBe(201);
    expect((await findPage('category:linear-attention'))?.key).toBe('linear-attention');
  });

  it('merges a duplicate: sections and links fold in, members follow, and it takes no more commits', async () => {
    const { cookie, actor } = await person('ada');
    const p1 = await paper('2404.00001');
    const p2 = await paper('2404.00002');
    expect((await newCategory(cookie, { name: 'Mixture of experts', summary: 'Routing tokens.' })).status).toBe(201);
    expect((await newCategory(cookie, { name: 'Sparse experts', summary: 'Sparse.' })).status).toBe(201);
    await addTo(cookie, 'arxiv:2404.00001', { category: 'category:mixture-of-experts' });
    await addTo(cookie, 'arxiv:2404.00002', { category: 'category:sparse-experts' });
    await catchUp();

    const merged = await api('POST', `/pages/${enc('category:sparse-experts')}/merge`, {
      cookie,
      body: { into: 'category:mixture-of-experts' },
    });
    expect(merged.status).toBe(200);
    await catchUp();

    const survivor = (await findKeyedPage(getDb(), 'category', 'mixture-of-experts'))!;
    expect((await findPage('category:sparse-experts'))!.id).toBe(survivor.id);
    expect(JSON.parse((await fileAt(survivor.id, 'category.json'))!)).toEqual({ name: 'Mixture of experts' });
    const [current] = await getDb()
      .select({ md: pageCurrent.communityMarkdown })
      .from(pageCurrent)
      .where(eq(pageCurrent.pageId, survivor.id));
    expect(current.md).toContain('Routing tokens.');
    expect(current.md).toContain('*From category:sparse-experts, merged into this page.*');
    expect(await membersOf('mixture-of-experts')).toEqual([p1, p2].sort());
    expect((await listed('mixture-of-experts')).pages.sort()).toEqual(['arxiv:2404.00001', 'arxiv:2404.00002']);
    expect((await listed('mixture-of-experts')).body.mergedFrom).toEqual(['category:sparse-experts']);

    const duplicate = (await findKeyedPage(getDb(), 'category', 'sparse-experts'))!;
    await expect(
      commitPage(
        duplicate.id,
        await readHead(getDb(), duplicate.id),
        actor,
        [{ path: 'community/x.md', content: 'x' }],
        'x',
      ),
    ).rejects.toMatchObject({ code: 'page_merged' });
    // Adding to the merged category adds to the survivor.
    const relinked = await addTo(cookie, 'arxiv:2404.00002', { category: 'category:sparse-experts' });
    expect(relinked.body.category.identifier).toBe('category:mixture-of-experts');
  });
});

describe('protection and the patrol feed', () => {
  it('holds back accounts below the level, and lets admins set and lift it', async () => {
    const ada = await person('ada');
    const admin = await person('patroller', 'admin@example.org');
    expect((await newCategory(ada.cookie, { name: 'Linear attention' })).status).toBe(201);
    const id = enc('category:linear-attention');
    const head = async () => readHead(getDb(), await categoryId('linear-attention'));

    expect(
      (await api('PUT', `/pages/${id}/protection`, { cookie: ada.cookie, body: { level: 'admins' } })).status,
    ).toBe(403);
    const set = await api('PUT', `/pages/${id}/protection`, {
      cookie: admin.cookie,
      body: { level: 'established', reason: 'Edit war over the history' },
    });
    expect(set.status).toBe(200);
    expect((await api('GET', `/pages/${id}/protection`)).body.protection).toMatchObject({ level: 'established' });

    // Ada was verified just now: not yet established.
    const refused = await api('PATCH', `/pages/${id}/category`, {
      cookie: ada.cookie,
      body: { base: await head(), article: '# History\n\nIt began in 2020.\n' },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('page_protected');
    expect(refused.body.error.message).toContain('Edit war over the history');
    // Renaming is an edit to the category too.
    expect(
      (await api('POST', `/pages/${id}/rename`, { cookie: ada.cookie, body: { slug: 'la' } })).body.error.code,
    ).toBe('page_protected');

    await getDb()
      .update(accounts)
      .set({ verifiedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) })
      .where(eq(accounts.id, ada.account.id));
    const allowed = await api('PATCH', `/pages/${id}/category`, {
      cookie: ada.cookie,
      body: { base: await head(), article: '# History\n\nIt began in 2020.\n' },
    });
    expect(allowed.status).toBe(200);

    await api('PUT', `/pages/${id}/protection`, { cookie: admin.cookie, body: { level: 'admins' } });
    const rename = async (cookie: string, name: string) =>
      api('PATCH', `/pages/${id}/category`, { cookie, body: { base: await head(), name } });
    expect((await rename(ada.cookie, 'Linear attentions (LA)')).status).toBe(403);
    expect((await rename(admin.cookie, 'Linear attention (LA)')).status).toBe(200);
    await api('PUT', `/pages/${id}/protection`, { cookie: admin.cookie, body: { level: null } });
    expect((await api('GET', `/pages/${id}/protection`)).body.protection).toBeNull();
  });

  it('lists every commit newest first, a page at a time', async () => {
    const { cookie } = await person('ada');
    expect((await newCategory(cookie, { name: 'Efficient transformers' })).status).toBe(201);
    expect((await newCategory(cookie, { name: 'Linear attention' })).status).toBe(201);
    const page = await findPage('category:linear-attention');
    await api('PATCH', `/pages/${enc('category:linear-attention')}/category`, {
      cookie,
      body: { base: await readHead(getDb(), page!.id), article: '# Key ideas\n\nKernels.\n', summary: 'Key ideas' },
    });
    await addTo(cookie, 'category:linear-attention', { category: 'category:efficient-transformers' });

    const all = await api('GET', '/changes?kind=category');
    expect(all.status).toBe(200);
    expect(all.body.changes.map((c: { summary: string }) => c.summary)).toEqual([
      'Add to the category Efficient transformers',
      'Key ideas',
      'Start Linear attention',
      'Start the category page linear-attention',
      'Start Efficient transformers',
      'Start the category page efficient-transformers',
    ]);
    expect(all.body.changes[0]).toMatchObject({ by: { handle: 'ada' }, links: true });
    expect(all.body.changes[3].by).toEqual({ system: true });

    const older = await api('GET', `/changes?kind=category&limit=2&before=${all.body.changes[1].id}`);
    expect(older.body.changes.map((c: { summary: string }) => c.summary)).toEqual([
      'Start Linear attention',
      'Start the category page linear-attention',
    ]);
  });
});

describe('keywords from a venue', () => {
  const FORMS = {
    Official_Review: {
      label: 'Official review',
      fields: [{ key: 'rating', label: 'Rating', type: 'score' as const, min: 1, max: 10 }],
      summary: ['rating'],
    },
  };

  /** A paper submitted to ICLR 2027 with these keywords and ratings, as the openreview bot commits it. */
  async function submitted(arxiv: string, title: string, keywords: string[], ratings: number[]) {
    const paperId = await paper(arxiv, title);
    const bot = await ensureBot(OPENREVIEW_BOT);
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    const forum = `f${arxiv.replace('.', '')}`;
    const license = 'CC-BY-4.0';
    const files = submissionFiles(
      { source: 'openreview', id: 'ICLR.cc/2027/Conference', name: 'ICLR 2027', url: null, forms: FORMS, license },
      {
        externalId: forum,
        paper: { scheme: 'arxiv', value: arxiv },
        number: 1,
        status: 'accepted',
        decision: 'Accept (Poster)',
        keywords,
        url: `https://openreview.net/forum?id=${forum}`,
        notes: ratings.map((rating, i) => ({
          externalId: `r${i}`,
          replyTo: null,
          kind: 'review' as const,
          invitation: 'Official_Review',
          signature: `Reviewer ${i}`,
          content: { rating },
          license,
          url: null,
          createdAt: new Date('2026-11-01T00:00:00Z'),
          modifiedAt: null,
        })),
      },
    );
    await commitPage(
      paperId,
      null,
      bot,
      [
        ...[...files].map(([path, content]) => ({ path, content })),
        submittedVersion(forum, 'ICLR 2027', 'accepted', 'Accept (Poster)'),
      ],
      'Import',
    );
    return paperId;
  }

  it('keeps keywords from submission.json', async () => {
    const high = await submitted('2405.00001', 'A first paper', ['Linear attention', 'RNNs'], [8, 6]);
    expect(await runConsumer(reviewsConsumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
    const [row] = await getDb()
      .select({ keywords: submissions.keywords })
      .from(submissions)
      .where(eq(submissions.paperId, high));
    expect(row.keywords).toEqual(['Linear attention', 'RNNs']);
    expect(await fileAt(high, 'reviews/openreview/f240500001/submission.json')).toContain('"keywords"');
  });
});
