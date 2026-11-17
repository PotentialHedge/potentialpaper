import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, pageCurrent, submissions, topicSuggestions, venues } from '@/db/schema';
import { rebuildConsumer, runConsumer } from '@/server/consumers/run';
import { linksConsumer, linksTo } from '@/server/page-links';
import { membersConsumer, scopeMembers } from '@/server/page-members';
import { commitPage } from '@/server/pages/commit';
import { findKeyedPage, findPage } from '@/server/pages/kinds';
import { readCommit, readFiles, readHead, readText } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { topicSuggestionsConsumer } from '@/server/topic-suggestions';
import { topicPapers } from '@/server/topic-papers';
import { api, closePool, resetDatabase, signUp } from './helpers';

/**
 * Topic pages (`handoffs/pages.md` Phase 5): making one with names checked first, putting a paper in one (and making
 * it by name), roll-up from narrower topics, "might belong here" with confirm and a dismissal that is remembered,
 * editing, renaming and merging with redirects, page protection and the patrol feed.
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

async function newTopic(cookie: string, body: Record<string, unknown>) {
  return api('POST', '/topics', { cookie, body });
}

async function catchUp() {
  for (const consumer of [linksConsumer, membersConsumer, topicSuggestionsConsumer]) {
    expect(await runConsumer(consumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
  }
}

async function fileAt(pageId: string, path: string): Promise<string | null> {
  const head = await readHead(getDb(), pageId);
  if (!head) return null;
  const commit = await readCommit(getDb(), pageId, head);
  return readText(getDb(), pageId, (await readFiles(getDb(), pageId, commit.tree)).get(path));
}

async function topicId(key: string) {
  return (await findKeyedPage(getDb(), 'topic', key))!.id;
}

async function membersOf(key: string, rollUp = true) {
  return (await scopeMembers(await topicId(key), { rollUp })).map((m) => m.paperId).sort();
}

describe('making a topic', () => {
  it('makes the page and its topic.json, checks names and aliases first, and refuses duplicates', async () => {
    const { cookie } = await person('ada');
    const made = await newTopic(cookie, {
      name: 'State-space models',
      aliases: ['SSMs'],
      summary: 'Sequence models with a linear recurrence.',
    });
    expect(made.status).toBe(201);
    expect(made.body.identifier).toBe('topic:state-space-models');
    const page = await findKeyedPage(getDb(), 'topic', 'state-space-models');
    expect(JSON.parse((await fileAt(page!.id, 'topic.json'))!)).toEqual({
      name: 'State-space models',
      aliases: ['SSMs'],
    });
    expect(await fileAt(page!.id, 'community/10-what-it-is.md')).toBe(
      '# What it is\n\nSequence models with a linear recurrence.\n',
    );

    // The same name, as duplicates are told: case, punctuation and plurals aside; and an alias.
    for (const name of ['state space model', 'SSM']) {
      const again = await newTopic(cookie, { name });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('topic_exists');
      expect(again.body.error.details.identifier).toBe('topic:state-space-models');
    }
    // A taken address with another name.
    const taken = await newTopic(cookie, { name: 'Other', slug: 'state-space-models' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('page_exists');

    // What the form shows as one types: the same name first, then similar ones.
    const found = await api('GET', `/topics?q=${enc('State space models')}`);
    expect(found.body.topics[0]).toMatchObject({ key: 'state-space-models', exact: true });
    const similar = await api('GET', `/topics?q=${enc('space model')}`);
    expect(similar.body.topics[0]).toMatchObject({ key: 'state-space-models', exact: false });

    // A broader topic must exist.
    const orphan = await newTopic(cookie, { name: 'Mamba', broader: ['no-such-topic'] });
    expect(orphan.status).toBe(422);
  });

  it('needs a verified account', async () => {
    expect((await newTopic('', { name: 'Linear attention' })).status).toBe(401);
  });
});

describe('papers in a topic', () => {
  it('links a paper by name, making the topic, from the community or from its authors, and rolls up', async () => {
    const { cookie } = await person('ada');
    const a = await paper('2401.00001', 'Transformers are RNNs');
    const b = await paper('2401.00002', 'Gated linear attention');
    expect((await newTopic(cookie, { name: 'Efficient transformers' })).status).toBe(201);

    // By a name no topic has: the topic is made, under the name given.
    const first = await api('POST', `/pages/${enc('arxiv:2401.00001')}/topics`, {
      cookie,
      body: { name: 'Linear attention', label: 'introduces-topic' },
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      status: 'linked',
      topic: { identifier: 'topic:linear-attention' },
    });
    const line = JSON.parse((await fileAt(a, 'community/links.jsonl'))!.trim());
    expect(line).toMatchObject({ to: 'topic:linear-attention', label: 'introduces-topic' });
    expect(line.id).toMatch(/^[0-9A-Z]{26}$/);

    // By a name it has (an alias works too): linked, not made again; and a second time is nothing new.
    const second = await api('POST', `/pages/${enc('arxiv:2401.00002')}/topics`, {
      cookie,
      body: { name: 'linear attention' },
    });
    expect(second.body).toMatchObject({ created: false, status: 'linked' });
    const again = await api('POST', `/pages/${enc('arxiv:2401.00002')}/topics`, {
      cookie,
      body: { topic: 'topic:linear-attention' },
    });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('exists');

    // Linear attention is under efficient transformers: its papers roll up.
    const page = await findPage('topic:linear-attention');
    const head = await readHead(getDb(), page!.id);
    const edit = await api('PATCH', `/pages/${enc('topic:linear-attention')}/topic`, {
      cookie,
      body: { base: head, broader: ['efficient-transformers'], summary: 'Under efficient transformers' },
    });
    expect(edit.status).toBe(200);
    expect(edit.body.changed).toBe(true);
    await catchUp();
    expect(await membersOf('linear-attention')).toEqual([a, b].sort());
    expect(await membersOf('efficient-transformers')).toEqual([a, b].sort());
    expect(await membersOf('efficient-transformers', false)).toEqual([]);

    const listed = await topicPapers(await topicId('efficient-transformers'));
    expect(listed.total).toBe(2);
    expect(listed.papers.every((p) => p.via?.key === 'linear-attention')).toBe(true);
    expect(listed.papers.find((p) => p.paperId === a)!.introduces).toBe(true);

    const overview = await api('GET', `/pages/${enc('topic:linear-attention')}/topic`);
    expect(overview.status).toBe(200);
    expect(overview.body.broader.map((t: { identifier: string }) => t.identifier)).toEqual([
      'topic:efficient-transformers',
    ]);
    expect(overview.body.introducedBy.map((p: { identifier: string }) => p.identifier)).toEqual(['arxiv:2401.00001']);
    const above = await api('GET', `/pages/${enc('topic:efficient-transformers')}/topic`);
    expect(above.body.narrower).toMatchObject([{ identifier: 'topic:linear-attention', papers: 2 }]);
    const sorted = await api('GET', `/pages/${enc('topic:efficient-transformers')}/topic-papers?sort=date`);
    expect(sorted.body.papers.map((p: { title: string }) => p.title)).toEqual([
      'Gated linear attention',
      'Transformers are RNNs',
    ]);
  });

  it("puts a confirmed author's topic links in author/", async () => {
    const author = await person('ada');
    const p = await paper('2401.00003');
    // The fixture's quickest way to an author: an admin's commit isn't one, so confirm a claim by hand.
    await getDb().execute(sql`
      insert into author_claims (paper_id, account_id, author_index, author_name, status, method, identity_id)
      values (${p}, ${author.account.id}, 0, 'Ada Lovelace', 'confirmed', 'manual', 'a_testtest')
    `);
    const linked = await api('POST', `/pages/${enc('arxiv:2401.00003')}/topics`, {
      cookie: author.cookie,
      body: { name: 'Mixture of experts' },
    });
    expect(linked.status).toBe(201);
    expect(await fileAt(p, 'author/links.jsonl')).toContain('topic:mixture-of-experts');
    expect(await fileAt(p, 'community/links.jsonl')).toBeNull();
  });
});

describe('might belong here', () => {
  it('suggests by keyword, title and abstract; confirming links, and a dismissal is remembered', async () => {
    const { cookie } = await person('ada');
    const byTitle = await paper('2402.00001', 'Linear attention at scale');
    const byAbstract = await paper('2402.00002', 'Fast models', 'We study linear attention for long contexts.');
    const byKeyword = await paper('2402.00003', 'Something else entirely');
    const unrelated = await paper('2402.00004', 'Attention is not linear', 'Nothing to see.');
    await getDb().insert(venues).values({ id: 'openreview:ICLR.cc/2027/Conference', name: 'ICLR 2027' });
    await getDb()
      .insert(submissions)
      .values({
        paperId: byKeyword,
        venueId: 'openreview:ICLR.cc/2027/Conference',
        externalId: 'abc',
        keywords: ['attention, linear', 'Linear Attentions'],
        fetchedAt: new Date(),
      });
    expect((await newTopic(cookie, { name: 'Linear attention' })).status).toBe(201);
    await catchUp();

    const list = await api('GET', `/pages/${enc('topic:linear-attention')}/suggestions`);
    expect(list.status).toBe(200);
    const reasons = Object.fromEntries(
      list.body.suggestions.map((s: { identifier: string; reason: string }) => [s.identifier, s.reason]),
    );
    expect(reasons).toEqual({
      'arxiv:2402.00003': 'keyword',
      'arxiv:2402.00001': 'title',
      'arxiv:2402.00002': 'abstract',
    });
    expect(list.body.suggestions[0].identifier).toBe('arxiv:2402.00003');
    expect(reasons['arxiv:2402.00004']).toBeUndefined();

    // Dismissed: remembered through a recompute and a rebuild.
    const dismissed = await api('POST', `/pages/${enc('topic:linear-attention')}/suggestions`, {
      cookie,
      body: { paper: 'arxiv:2402.00002', action: 'dismiss' },
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.total).toBe(2);
    // Confirmed: the paper is linked.
    const confirmed = await api('POST', `/pages/${enc('topic:linear-attention')}/suggestions`, {
      cookie,
      body: { paper: 'arxiv:2402.00001', action: 'confirm' },
    });
    expect(confirmed.body.total).toBe(1);
    expect(await fileAt(byTitle, 'community/links.jsonl')).toContain('"label":"in-topic"');
    await rebuildConsumer(topicSuggestionsConsumer);
    await catchUp();
    const rows = await getDb()
      .select({ paperId: topicSuggestions.paperId, status: topicSuggestions.status })
      .from(topicSuggestions)
      .where(eq(topicSuggestions.topicPageId, await topicId('linear-attention')));
    expect(Object.fromEntries(rows.map((r) => [r.paperId, r.status]))).toEqual({
      [byTitle]: 'confirmed',
      [byAbstract]: 'dismissed',
      [byKeyword]: 'open',
    });
    expect(await membersOf('linear-attention')).toEqual([byTitle]);
    void unrelated;
  });
});

describe('renaming and merging', () => {
  it('renames with a redirect: old links, broader lists and the address still find it', async () => {
    const { cookie } = await person('ada');
    const p = await paper('2403.00001');
    expect((await newTopic(cookie, { name: 'Linear attention' })).status).toBe(201);
    expect((await newTopic(cookie, { name: 'Gated linear attention', broader: ['linear-attention'] })).status).toBe(
      201,
    );
    await api('POST', `/pages/${enc('arxiv:2403.00001')}/topics`, {
      cookie,
      body: { topic: 'topic:linear-attention' },
    });
    await catchUp();

    const renamed = await api('POST', `/pages/${enc('topic:linear-attention')}/rename`, {
      cookie,
      body: { slug: 'linearised-attention', name: 'Linearised attention' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.identifier).toBe('topic:linearised-attention');
    await catchUp();

    const page = await findPage('topic:linear-attention');
    expect(page?.key).toBe('linearised-attention');
    expect(JSON.parse((await fileAt(page!.id, 'topic.json'))!)).toEqual({
      name: 'Linearised attention',
      aliases: ['Linear attention'],
    });
    // The paper's link still names topic:linear-attention; it counts, and so does the narrower topic's broader.
    expect(await membersOf('linearised-attention', false)).toEqual([p]);
    const narrower = await api('GET', `/pages/${enc('topic:linearised-attention')}/topic`);
    expect(narrower.body.narrower.map((t: { identifier: string }) => t.identifier)).toEqual([
      'topic:gated-linear-attention',
    ]);
    expect((await linksTo(page!.id)).map((l) => l.page.pageId)).toEqual([p]);

    // A new topic may take the old slug: the redirect gives way.
    expect((await newTopic(cookie, { name: 'Something new', slug: 'linear-attention' })).status).toBe(201);
    expect((await findPage('topic:linear-attention'))?.key).toBe('linear-attention');
  });

  it('merges a duplicate: names, sections and links fold in, members follow, and it takes no more commits', async () => {
    const { cookie, actor } = await person('ada');
    const p1 = await paper('2404.00001');
    const p2 = await paper('2404.00002');
    expect((await newTopic(cookie, { name: 'Mixture of experts', summary: 'Routing tokens.' })).status).toBe(201);
    expect(
      (await newTopic(cookie, { name: 'Sparse experts', aliases: ['MoE layers'], summary: 'Sparse.' })).status,
    ).toBe(201);
    await api('POST', `/pages/${enc('arxiv:2404.00001')}/topics`, {
      cookie,
      body: { topic: 'topic:mixture-of-experts' },
    });
    await api('POST', `/pages/${enc('arxiv:2404.00002')}/topics`, { cookie, body: { topic: 'topic:sparse-experts' } });
    await catchUp();
    await getDb()
      .insert(topicSuggestions)
      .values({
        topicPageId: await topicId('sparse-experts'),
        paperId: p1,
        status: 'dismissed',
        reason: 'title',
        matched: 'Sparse experts',
        score: 2,
      });

    const merged = await api('POST', `/pages/${enc('topic:sparse-experts')}/merge`, {
      cookie,
      body: { into: 'topic:mixture-of-experts' },
    });
    expect(merged.status).toBe(200);
    await catchUp();

    const survivor = (await findKeyedPage(getDb(), 'topic', 'mixture-of-experts'))!;
    expect((await findPage('topic:sparse-experts'))!.id).toBe(survivor.id);
    expect(JSON.parse((await fileAt(survivor.id, 'topic.json'))!)).toEqual({
      name: 'Mixture of experts',
      aliases: ['Sparse experts', 'MoE layers'],
    });
    const [current] = await getDb()
      .select({ md: pageCurrent.communityMarkdown })
      .from(pageCurrent)
      .where(eq(pageCurrent.pageId, survivor.id));
    expect(current.md).toContain('Routing tokens.');
    expect(current.md).toContain('*From topic:sparse-experts, merged into this page.*');
    expect(await membersOf('mixture-of-experts')).toEqual([p1, p2].sort());
    // The dismissal moved along.
    const [moved] = await getDb()
      .select({ status: topicSuggestions.status })
      .from(topicSuggestions)
      .where(and(eq(topicSuggestions.topicPageId, survivor.id), eq(topicSuggestions.paperId, p1)));
    expect(moved.status).toBe('dismissed');

    const duplicate = (await findKeyedPage(getDb(), 'topic', 'sparse-experts'))!;
    await expect(
      commitPage(
        duplicate.id,
        await readHead(getDb(), duplicate.id),
        actor,
        [{ path: 'community/x.md', content: 'x' }],
        'x',
      ),
    ).rejects.toMatchObject({ code: 'page_merged' });
    // Linking to the merged topic links to the survivor.
    const relinked = await api('POST', `/pages/${enc('arxiv:2404.00002')}/topics`, {
      cookie,
      body: { topic: 'topic:sparse-experts' },
    });
    expect(relinked.body.topic.identifier).toBe('topic:mixture-of-experts');
  });
});

describe('protection and the patrol feed', () => {
  it('holds back accounts below the level, and lets admins set and lift it', async () => {
    const ada = await person('ada');
    const admin = await person('patroller', 'admin@example.org');
    expect((await newTopic(ada.cookie, { name: 'Linear attention' })).status).toBe(201);
    const id = enc('topic:linear-attention');
    const head = async () => readHead(getDb(), await topicId('linear-attention'));

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
    const refused = await api('PATCH', `/pages/${id}/topic`, {
      cookie: ada.cookie,
      body: { base: await head(), article: '# History\n\nIt began in 2020.\n' },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('page_protected');
    expect(refused.body.error.message).toContain('Edit war over the history');
    // Dismissing a suggestion and renaming are edits to the topic too.
    expect(
      (await api('POST', `/pages/${id}/rename`, { cookie: ada.cookie, body: { slug: 'la' } })).body.error.code,
    ).toBe('page_protected');

    await getDb()
      .update(accounts)
      .set({ verifiedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000) })
      .where(eq(accounts.id, ada.account.id));
    const allowed = await api('PATCH', `/pages/${id}/topic`, {
      cookie: ada.cookie,
      body: { base: await head(), article: '# History\n\nIt began in 2020.\n' },
    });
    expect(allowed.status).toBe(200);

    await api('PUT', `/pages/${id}/protection`, { cookie: admin.cookie, body: { level: 'admins' } });
    expect(
      (
        await api('PATCH', `/pages/${id}/topic`, {
          cookie: ada.cookie,
          body: { base: await head(), aliases: ['LA'] },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api('PATCH', `/pages/${id}/topic`, {
          cookie: admin.cookie,
          body: { base: await head(), aliases: ['LA'] },
        })
      ).status,
    ).toBe(200);
    await api('PUT', `/pages/${id}/protection`, { cookie: admin.cookie, body: { level: null } });
    expect((await api('GET', `/pages/${id}/protection`)).body.protection).toBeNull();
  });

  it('lists every commit newest first, and picks out changes that move papers between roll-ups', async () => {
    const { cookie } = await person('ada');
    expect((await newTopic(cookie, { name: 'Efficient transformers' })).status).toBe(201);
    expect((await newTopic(cookie, { name: 'Linear attention' })).status).toBe(201);
    const page = await findPage('topic:linear-attention');
    await api('PATCH', `/pages/${enc('topic:linear-attention')}/topic`, {
      cookie,
      body: { base: await readHead(getDb(), page!.id), article: '# Key ideas\n\nKernels.\n', summary: 'Key ideas' },
    });
    await api('PATCH', `/pages/${enc('topic:linear-attention')}/topic`, {
      cookie,
      body: { base: await readHead(getDb(), page!.id), broader: ['efficient-transformers'], summary: 'Broader' },
    });

    const all = await api('GET', '/changes?kind=topic');
    expect(all.status).toBe(200);
    expect(all.body.changes.map((c: { summary: string }) => c.summary)).toEqual([
      'Broader',
      'Key ideas',
      'Start Linear attention',
      'Start the topic page linear-attention',
      'Start Efficient transformers',
      'Start the topic page efficient-transformers',
    ]);
    expect(all.body.changes[0]).toMatchObject({ by: { handle: 'ada' }, rollUp: true });
    expect(all.body.changes[3].by).toEqual({ system: true });

    const rollUp = await api('GET', '/changes?rollUp=true');
    expect(rollUp.body.changes.map((c: { summary: string }) => c.summary)).toEqual(['Broader']);
    const older = await api('GET', `/changes?kind=topic&limit=2&before=${all.body.changes[1].id}`);
    expect(older.body.changes.map((c: { summary: string }) => c.summary)).toEqual([
      'Start Linear attention',
      'Start the topic page linear-attention',
    ]);
  });
});
