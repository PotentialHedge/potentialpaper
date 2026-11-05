import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as paperRoute from '@/app/api/v1/papers/[scheme]/[...value]/route';
import * as searchRoute from '@/app/api/v1/search/route';
import { getDb } from '@/db';
import { paperIdentifiers, papers } from '@/db/schema';
import { importSubmissions } from '@/server/import-submissions';
import { SourceUnavailable, type PaperSource, type SourcePaper } from '@/server/paper-sources/types';
import { paperGate } from '@/server/paper-gate';
import { lookupPaper, savePaper } from '@/server/papers';
import { searchPapers } from '@/server/search';
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

describe('looking up a paper', () => {
  it('makes the row on the first visit, and never asks the source again', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    const first = await lookupPaper(ID, { sources: { arxiv } });
    expect(first.status === 'found' && first.paper.title).toBe(ATTENTION.title);
    await lookupPaper(ID, { sources: { arxiv } });
    expect(arxiv.calls()).toBe(1);
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

  it('lets a known paper through at its own address', async () => {
    await savePaper(ATTENTION);
    expect(await paperGate('/abs/1706.03762', noSource)).toEqual({ action: 'render' });
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

  it('keeps old arXiv ids and encoded DOIs at their address', async () => {
    await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'arxiv', value: 'hep-th/9901001' }] });
    await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'doi', value: '10.1000/(a)<b>' }] });
    expect(await paperGate('/abs/hep-th/9901001', noSource)).toEqual({ action: 'render' });
    expect(await paperGate('/doi/10.1000/(a)%3Cb%3E', noSource)).toEqual({ action: 'render' });
  });

  it('calls junk missing, however it is spelled', async () => {
    for (const path of ['/abs', '/abs/garbage', '/abs/%E0%A4%A', '/openreview/nosuchpaper', '/openreview/a/b']) {
      expect(await paperGate(path, noSource)).toEqual({ action: 'missing' });
    }
  });

  it('fetches a new paper once, then renders it', async () => {
    const arxiv = fakeSource(async () => ATTENTION);
    expect(await paperGate('/abs/1706.03762', { sources: { arxiv } })).toEqual({ action: 'render' });
    expect(arxiv.calls()).toBe(1);
  });

  it('reports an outage', async () => {
    const arxiv = fakeSource(async () => null, 0);
    expect(await paperGate('/abs/1706.03762', { sources: { arxiv } })).toEqual({ action: 'unavailable' });
  });

  it("sends a merged duplicate's address to the survivor", async () => {
    const survivor = await savePaper(ATTENTION);
    const duplicate = await savePaper({ ...ATTENTION, identifiers: [{ scheme: 'doi', value: '10.1000/dup' }] });
    await getDb().update(papers).set({ mergedInto: survivor }).where(eq(papers.id, duplicate));
    expect(await paperGate('/doi/10.1000/dup', noSource)).toEqual({ action: 'redirect', to: '/abs/1706.03762' });
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
      abstract: 'Skip connections help very deep networks.',
      identifiers: [{ scheme: 'doi', value: '10.1/resnet' }],
    });
  });

  it('finds words in titles and abstracts', async () => {
    expect((await searchPapers('attention')).hits[0].title).toBe(ATTENTION.title);
    expect((await searchPapers('skip connections')).hits[0].value).toBe('10.1/resnet');
  });

  it('finds a misspelled title', async () => {
    expect((await searchPapers('atention is all you ned')).hits[0].title).toBe(ATTENTION.title);
  });

  it('survives operators and punctuation in a query', async () => {
    for (const q of ["'; drop table papers; --", '"unterminated', 'a & | ! (b', '-']) {
      await expect(searchPapers(q)).resolves.toBeDefined();
    }
  });

  it('hides a merged duplicate', async () => {
    const survivor = await savePaper(ATTENTION);
    const [resnet] = await getDb().select().from(papers).where(eq(papers.title, 'Deep residual learning'));
    await getDb().update(papers).set({ mergedInto: survivor }).where(eq(papers.id, resnet.id));
    expect((await searchPapers('residual')).hits).toHaveLength(0);
  });

  it('pages through results', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...ATTENTION,
      title: `Quantum bananas ${i}`,
      identifiers: [{ scheme: 'doi' as const, value: `10.1/banana${i}` }],
    }));
    for (const paper of many) await savePaper(paper);
    const first = await searchPapers('quantum bananas');
    expect(first.hits).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    const second = await searchPapers('quantum bananas', 2);
    expect(second.hits).toHaveLength(5);
    expect(second.hasMore).toBe(false);
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
    expect(body.path).toBe('/abs/1706.03762');
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
    expect(body.hits[0].path).toBe('/abs/1706.03762');
  });
});
