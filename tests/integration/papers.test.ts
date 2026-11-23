import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as paperRoute from '@/app/api/v1/papers/[scheme]/[...value]/route';
import * as searchRoute from '@/app/api/v1/search/route';
import type { SearchSort } from '@/lib/search';
import { getDb } from '@/db';
import { pages, paperIdentifiers, papers } from '@/db/schema';
import { importSubmissions } from '@/server/import-submissions';
import { SourceUnavailable, type PaperSource, type SourcePaper } from '@/server/paper-sources/types';
import { paperGate, shortGate } from '@/server/paper-gate';
import { describePaper, lookupPaper, savePaper, startVersions } from '@/server/papers';
import { currentVersions } from '@/server/versions';
import { searchPapers, similarPapers, topVenues } from '@/server/search';
import { closePool, ORIGIN, resetDatabase } from './helpers';

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());
afterAll(closePool);

const ATTENTION: SourcePaper = {
  title: 'Attention Is All You Need',
  authors: ['Ashish Vaswani'],
  abstract: 'The dominant sequence transduction models are based on recurrent networks.',
  year: 2017,
  venue: null,
  identifiers: [{ scheme: 'arxiv', value: '1706.03762' }],
  source: 'arxiv',
  metadataLicense: 'CC0-1.0',
  abstractLicense: 'CC0-1.0',
  versions: [
    { label: 'arXiv v1', kind: 'preprint', date: '2017-06-12', url: 'https://arxiv.org/abs/1706.03762v1' },
    { label: 'arXiv v7', kind: 'preprint', date: '2023-08-02', url: 'https://arxiv.org/abs/1706.03762v7' },
  ],
};
const ID = { scheme: 'arxiv', value: '1706.03762' } as const;

function fakeSource(answer: () => Promise<SourcePaper | null>, burst = 100): PaperSource & { calls: () => number } {
  let calls = 0;
  return {
    name: `fake-${crypto.randomUUID()}`,
    budget: { burst, perSecond: 0.0001 },
    fetch: () => {
      calls += 1;
      return answer();
    },
    calls: () => calls,
  };
}

describe('describing a paper new to us', () => {
  it('says what the source says without adding it, and adding it then asks no more', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    const described = await describePaper(ID, { sources: { arxiv } });
    expect(described.status === 'described' && described.paper.title).toBe(ATTENTION.title);
    expect(await getDb().select().from(papers)).toHaveLength(0);
    const added = await lookupPaper(ID, { sources: { arxiv } });
    expect(added.status).toBe('found');
    expect(arxiv.calls()).toBe(1);
    expect((await describePaper(ID, { sources: { arxiv } })).status).toBe('found');
  });

  it('finds papers with titles like it, reworded', async () => {
    await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'doi', value: '10.1/attention' }] });
    await savePaper({
      ...ATTENTION,
      title: 'Deep Residual Learning',
      identifiers: [{ scheme: 'doi', value: '10.1/resnet' }],
    });
    const similar = await similarPapers('Attention is all you need, revisited');
    expect(similar.map((p) => p.title)).toEqual(['Attention Is All You Need']);
  });
});

describe('looking up a paper', () => {
  it('makes the row on the first visit, and never asks the source again', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    const first = await lookupPaper(ID, { sources: { arxiv } });
    expect(first.status === 'found' && first.paper.title).toBe(ATTENTION.title);
    await lookupPaper(ID, { sources: { arxiv } });
    expect(arxiv.calls()).toBe(1);
  });

  it('starts a new paper with the versions its source lists', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    const found = await lookupPaper(ID, { sources: { arxiv } });
    if (found.status !== 'found') throw new Error(found.status);
    const versions = await currentVersions(found.paper.id);
    expect(versions.map((v) => [v.label, v.date])).toEqual([
      ['arXiv v1', '2017-06-12'],
      ['arXiv v7', '2023-08-02'],
    ]);
    // A paper that has versions keeps them.
    expect(await startVersions(found.paper.id, { versions: [{ label: 'Other', kind: 'other' }] })).toBe(false);
    expect(await currentVersions(found.paper.id)).toHaveLength(2);
  });

  it('remembers a miss', async () => {
    const arxiv = fakeSource(async () => null);
    expect((await lookupPaper(ID, { sources: { arxiv } })).status).toBe('missing');
    expect((await lookupPaper(ID, { sources: { arxiv } })).status).toBe('missing');
    expect(arxiv.calls()).toBe(1);
  });

  it('does not remember an outage', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    let up = false;
    const arxiv = fakeSource(async () => {
      if (!up) throw new SourceUnavailable('down');
      return ATTENTION;
    });
    expect((await lookupPaper(ID, { sources: { arxiv } })).status).toBe('unavailable');
    up = true;
    expect((await lookupPaper(ID, { sources: { arxiv } })).status).toBe('found');
  });

  it('stops asking when the shared budget is spent', async () => {
    const arxiv = fakeSource(async () => null, 1);
    await lookupPaper(ID, { sources: { arxiv } });
    const second = await lookupPaper({ scheme: 'arxiv', value: '1706.03763' }, { sources: { arxiv } });
    expect(second.status).toBe('unavailable');
    expect(arxiv.calls()).toBe(1);
  });

  it('waits briefly for the budget rather than failing', async () => {
    const arxiv = fakeSource(async () => null);
    arxiv.budget = { burst: 1, perSecond: 2 };
    await lookupPaper(ID, { sources: { arxiv } });
    const second = await lookupPaper({ scheme: 'arxiv', value: '1706.03763' }, { sources: { arxiv } });
    expect(second.status).toBe('missing');
    expect(arxiv.calls()).toBe(2);
  });

  it('asks once for concurrent requests about one new paper', async () => {
    const arxiv = fakeSource(async () => ATTENTION, 1);
    const results = await Promise.all([
      lookupPaper(ID, { sources: { arxiv } }),
      lookupPaper(ID, { sources: { arxiv } }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['found', 'found']);
    expect(arxiv.calls()).toBe(1);
  });

  it('has no source for OpenReview: only an import adds those', async () => {
    expect((await lookupPaper({ scheme: 'openreview', value: 'abcdefgh' })).status).toBe('missing');
  });

  it('joins two identifiers of one paper into one row', async () => {
    await savePaper(ATTENTION);
    const doi = { scheme: 'doi', value: '10.1/attention' } as const;
    await savePaper({ ...ATTENTION, title: 'Other spelling', identifiers: [doi, ID] });
    expect(await getDb().select().from(papers)).toHaveLength(1);
    const found = await lookupPaper(doi);
    expect(found.status === 'found' && found.paper.title).toBe(ATTENTION.title);
    expect(found.status === 'found' && found.paper).toMatchObject({ source: 'arxiv', abstractLicense: 'CC0-1.0' });
    expect(found.status === 'found' && found.identifiers).toHaveLength(2);
  });

  it('makes one row when the same new paper is fetched concurrently', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    const results = await Promise.all(Array.from({ length: 8 }, () => lookupPaper(ID, { sources: { arxiv } })));
    expect(results.every((r) => r.status === 'found')).toBe(true);
    expect(await getDb().select().from(papers)).toHaveLength(1);
  });

  it('follows a merge to the survivor, and says so', async () => {
    const survivor = await savePaper(ATTENTION);
    const duplicate = await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'doi', value: '10.1/dup' }] });
    await getDb().update(papers).set({ mergedInto: survivor }).where(eq(papers.id, duplicate));
    const found = await lookupPaper({ scheme: 'doi', value: '10.1/dup' });
    expect(found.status === 'found' && found.merged).toBe(true);
    expect(found.status === 'found' && found.paper.id).toBe(survivor);
  });
});

describe('the gate in front of paper pages', () => {
  const noSource = { sources: {} };
  /** Where a paper's page is: its short address. */
  const short = async (paperId: string) => {
    const [row] = await getDb().select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, paperId));
    return { action: 'redirect', to: `/s/${row.shortId}` };
  };

  it("sends a known paper's address to its short one, where it is rendered", async () => {
    const id = await savePaper(ATTENTION);
    expect(await paperGate('/abs/1706.03762', noSource)).toEqual(await short(id));
    const [row] = await getDb().select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, id));
    expect(await shortGate(String(row.shortId))).toEqual({ action: 'render', path: '/abs/1706.03762' });
    expect(await shortGate('999999')).toEqual({ action: 'missing' });
    expect(await shortGate('x1')).toEqual({ action: 'missing' });
  });

  it('redirects another spelling without looking anything up', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    const options = { sources: { arxiv } };
    expect(await paperGate('/abs/1706.03762v5', options)).toEqual({ action: 'redirect', to: '/abs/1706.03762' });
    expect(await paperGate('/doi/10.48550/arXiv.1706.03762', options)).toEqual({
      action: 'redirect',
      to: '/abs/1706.03762',
    });
    expect(arxiv.calls()).toBe(0);
  });

  it('knows old arXiv ids and encoded DOIs', async () => {
    const old = await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'arxiv', value: 'hep-th/9901001' }] });
    const doi = await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'doi', value: '10.1000/(a)<b>' }] });
    expect(await paperGate('/abs/hep-th/9901001', noSource)).toEqual(await short(old));
    expect(await paperGate('/doi/10.1000/(a)%3Cb%3E', noSource)).toEqual(await short(doi));
  });

  it('calls junk missing, however it is spelled', async () => {
    for (const path of ['/abs', '/abs/garbage', '/abs/%E0%A4%A', '/openreview/nosuchpaper', '/openreview/a/b']) {
      expect(await paperGate(path, noSource)).toEqual({ action: 'missing' });
    }
  });

  it('fetches a new paper once', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    expect(await paperGate('/abs/1706.03762', { sources: { arxiv } })).toMatchObject({ action: 'redirect' });
    expect(arxiv.calls()).toBe(1);
  });

  it('reports an outage', async () => {
    const arxiv = fakeSource(async () => null, 0);
    expect(await paperGate('/abs/1706.03762', { sources: { arxiv } })).toEqual({ action: 'unavailable' });
  });

  it("sends each of a paper's identifiers to its short address, rendered from the canonical one", async () => {
    const id = await savePaper({
      ...ATTENTION,
      identifiers: [
        { scheme: 'arxiv', value: '1706.03762' },
        { scheme: 'doi', value: '10.1000/attention' },
        { scheme: 'openreview', value: 'attn123' },
      ],
    });
    for (const path of ['/doi/10.1000/attention', '/openreview/attn123', '/abs/1706.03762']) {
      expect(await paperGate(path, noSource)).toEqual(await short(id));
    }
  });

  it("sends a merged duplicate's addresses to the survivor's", async () => {
    const survivor = await savePaper(ATTENTION);
    const duplicate = await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'doi', value: '10.1000/dup' }] });
    await getDb().update(papers).set({ mergedInto: survivor }).where(eq(papers.id, duplicate));
    expect(await paperGate('/doi/10.1000/dup', noSource)).toEqual(await short(survivor));
    const [row] = await getDb().select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, duplicate));
    expect(await shortGate(String(row.shortId))).toEqual(await short(survivor));
  });
});

describe('importing submissions', () => {
  const submissions = [
    { id: 'submission1', title: 'Sparse routing for vision models', abstract: 'x'.repeat(60) },
    { id: 'wnlWatgGQl', title: 'Internal Test', abstract: 'test' },
  ];
  const venue = { name: 'ICLR 2027 (under review)', year: 2027 };

  it('skips test notes, stays anonymous, and can run twice', async () => {
    expect(await importSubmissions(submissions, venue)).toBe(1);
    expect(await importSubmissions(submissions, venue)).toBe(0);
    const found = await lookupPaper({ scheme: 'openreview', value: 'submission1' });
    expect(found.status === 'found' && found.paper.authors).toEqual([]);
    expect(found.status === 'found' && found.paper).toMatchObject({
      source: 'openreview',
      metadataLicense: 'CC0-1.0',
      abstractLicense: 'CC0-1.0',
    });
    expect(await getDb().select().from(paperIdentifiers)).toHaveLength(1);
  });

  it('keeps the authors and venue of a paper whose review has ended', async () => {
    const decided = { ...submissions[0], authors: ['Ada Lovelace'], venue: 'ICLR 2026 submission' };
    expect(await importSubmissions([decided], venue)).toBe(1);
    const found = await lookupPaper({ scheme: 'openreview', value: decided.id });
    expect(found.status === 'found' && [found.paper.authors, found.paper.venue]).toEqual([
      ['Ada Lovelace'],
      'ICLR 2026 submission',
    ]);
  });
});

describe('search', () => {
  beforeEach(async () => {
    await savePaper(ATTENTION);
    await savePaper({
      ...ATTENTION,
      title: 'Deep residual learning',
      authors: ['Kaiming He'],
      abstract: 'Skip connections help very deep networks.',
      identifiers: [{ scheme: 'doi', value: '10.1/resnet' }],
    });
  });

  it('finds words in titles and abstracts', async () => {
    expect((await searchPapers({ q: 'attention' })).hits[0].title).toBe(ATTENTION.title);
    expect((await searchPapers({ q: 'skip connections' })).hits[0].value).toBe('10.1/resnet');
  });

  it('finds a misspelled title', async () => {
    expect((await searchPapers({ q: 'atention is all you ned' })).hits[0].title).toBe(ATTENTION.title);
  });

  it('survives operators and punctuation in a query', async () => {
    for (const q of ["'; drop table papers; --", '"unterminated', 'a & | ! (b', '-']) {
      await expect(searchPapers({ q })).resolves.toBeDefined();
    }
  });

  it('hides a merged duplicate', async () => {
    const survivor = await savePaper(ATTENTION);
    const [resnet] = await getDb().select().from(papers).where(eq(papers.title, 'Deep residual learning'));
    await getDb().update(papers).set({ mergedInto: survivor }).where(eq(papers.id, resnet.id));
    expect((await searchPapers({ q: 'residual' })).hits).toHaveLength(0);
  });

  it('pages through results', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...ATTENTION,
      title: `Quantum bananas ${i}`,
      identifiers: [{ scheme: 'doi' as const, value: `10.1/banana${i}` }],
    }));
    for (const paper of many) await savePaper(paper);
    const first = await searchPapers({ q: 'quantum bananas', limit: 20 });
    expect(first.hits).toHaveLength(20);
    expect(first.total).toBe(25);
    const second = await searchPapers({ q: 'quantum bananas', limit: 20, page: 2 });
    expect(second.hits).toHaveLength(5);
  });

  it('reads the search syntax', async () => {
    const title = async (q: string) => (await searchPapers({ q })).hits.map((h) => h.title);
    expect(await title('author:vaswani')).toEqual([ATTENTION.title]);
    expect(await title('year<2000')).toEqual([]);
    expect(await title('-attention year>=2017')).toEqual(['Deep residual learning']);
    expect(await title('title:residual OR title:attention')).toHaveLength(2);
    expect(await title('"residual attention"')).toEqual([]);
    expect(await title('resid')).toEqual(['Deep residual learning']);
    expect(await title('attention OR residual')).toHaveLength(2);
    expect(await title('attention OR year<2000')).toEqual([ATTENTION.title]);
    expect(await title('-(attention OR residual)')).toEqual([]);
    expect(await title('author!=vaswani')).toEqual(['Deep residual learning']);
  });

  it('keeps a pattern from matching more than it says', async () => {
    expect((await searchPapers({ q: 'title:"%"' })).total).toBe(0);
  });

  it('filters by one venue, and lists the venues with most papers', async () => {
    const venued = (venue: string, value: string) =>
      savePaper({
        ...ATTENTION,
        title: `Paper ${value}`,
        venue,
        identifiers: [{ scheme: 'doi', value: `10.1/${value}` }],
      });
    await venued('ICLR 2026', 'a');
    await venued('ICLR 2026', 'b');
    await venued('NeurIPS', 'c');
    expect((await searchPapers({ venue: 'NeurIPS' })).hits.map((h) => h.title)).toEqual(['Paper c']);
    expect(await topVenues()).toEqual(['ICLR 2026', 'NeurIPS']);
  });

  it('sorts', async () => {
    const dated = (title: string, year: number | null, value: string) =>
      savePaper({ ...ATTENTION, title, year, identifiers: [{ scheme: 'doi', value: `10.1/${value}` }] });
    await dated('Banana', 2030, 'a');
    await dated('apple', 1990, 'b');
    await dated('Undated', null, 'c');
    const titles = async (sort: SearchSort) => (await searchPapers({ sort })).hits.map((h) => h.title);
    expect((await titles('newest'))[0]).toBe('Banana');
    expect((await titles('oldest'))[0]).toBe('apple');
    expect(await titles('oldest')).toHaveLength(5);
    expect((await titles('newest')).at(-1)).toBe('Undated');
    expect((await titles('oldest')).at(-1)).toBe('Undated');
    expect((await titles('title')).slice(0, 2)).toEqual(['apple', 'Attention Is All You Need']);
  });

  it('with nothing to search for, lists every paper', async () => {
    expect((await searchPapers()).total).toBe(2);
    expect((await searchPapers({ q: '  ' })).total).toBe(2);
    expect((await searchPapers({ sort: 'relevance' })).total).toBe(2);
  });
});

describe('the API', () => {
  const get = (scheme: string, value: string[]) =>
    paperRoute.GET(new Request(`${ORIGIN}/api/v1/papers/${scheme}/${value.join('/')}`), {
      params: Promise.resolve({ scheme, value }),
    });

  it('serves a known paper under any of its identifiers, with its canonical address', async () => {
    await savePaper({ ...ATTENTION, identifiers: [ID, { scheme: 'doi', value: '10.1000/a' }] });
    const res = await get('doi', ['10.1000', 'a']);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe(ATTENTION.title);
    expect(body.path).toMatch(/^\/s\/\d+$/);
    expect(body).not.toHaveProperty('id');
  });

  it('answers 404 for an invalid identifier without calling anyone', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    expect((await get('arxiv', ['not-an-id'])).status).toBe(404);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('answers 404 for a malformed escape', async () => {
    expect((await get('doi', ['10.1000', '%E0%A4%A'])).status).toBe(404);
  });

  it('answers 400 for an unknown scheme', async () => {
    expect((await get('pubmed', ['123'])).status).toBe(400);
  });

  it('answers 503 with Retry-After when the source is down', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 503 })),
    );
    const res = await get('arxiv', ['1706.03762']);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('source_unavailable');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('searches', async () => {
    await savePaper(ATTENTION);
    const req = new Request(`${ORIGIN}/api/v1/search?q=attention`);
    const res = await searchRoute.GET(req, { params: Promise.resolve({}) });
    const body = await res.json();
    expect(body.hits[0].path).toMatch(/^\/s\/\d+$/);
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
  });
});
