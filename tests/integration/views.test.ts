import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { pages, pageTransitions, pageViews } from '@/db/schema';
import { savePaper } from '@/server/papers';
import { insertPage } from '@/server/pages/kinds';
import { countTransition, countView } from '@/server/view-counter';
import { api, closePool, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani'],
    abstract: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

let pageId: string;

const view = (ip: string, opts: { cookie?: string; page?: string; from?: string } = {}) =>
  api('POST', '/views', {
    cookie: opts.cookie,
    body: { page: opts.page ?? pageId, ...(opts.from ? { from: opts.from } : {}) },
    headers: { 'cf-connecting-ip': ip },
  });

describe('POST /views', () => {
  it('counts a visitor once a day, and a different visitor again', async () => {
    const id = (pageId = await paper());
    const reader = await signUp('reader@ethz.ch');
    expect((await view('203.0.113.1')).body).toEqual({ views: null, shown: false });
    expect((await view('203.0.113.1')).body).toEqual({ views: null, shown: false });
    expect((await view('203.0.113.2', { cookie: reader })).body).toEqual({ views: 2, shown: false });
    const [row] = await getDb().select({ n: pages.viewCount }).from(pages).where(eq(pages.id, id));
    expect(row.n).toBe(2);
  });

  it('counts an IPv6 /64 once, whichever address in it sends', async () => {
    pageId = await paper();
    await view('2001:db8:1:2::1');
    await view('2001:db8:1:2:ffff:ffff:ffff:ffff');
    await view('2001:db8:1:3::1');
    const [row] = await getDb().select({ n: pages.viewCount }).from(pages).where(eq(pages.id, pageId));
    expect(row.n).toBe(2);
  });

  it('counts each signed-in account once, apart from its network', async () => {
    pageId = await paper();
    const cookie = await signUp('reader@ethz.ch');
    await view('203.0.113.1');
    expect((await view('203.0.113.1', { cookie })).body.views).toBe(2);
    expect((await view('198.51.100.7', { cookie })).body.views).toBe(2);
  });

  it('counts the same visitor again the next day, and stores no address', async () => {
    const id = await paper();
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    expect(await countView(id, { ip: '203.0.113.1' }, today)).toBe(1);
    expect(await countView(id, { ip: '203.0.113.1' }, tomorrow)).toBe(2);
    const rows = await getDb().select().from(pageViews);
    expect(rows).toHaveLength(2);
    expect(rows[0].visitor).not.toBe(rows[1].visitor);
    expect(JSON.stringify(rows)).not.toContain('203.0.113.1');
  });

  it('is a 404 for an unknown page', async () => {
    expect((await view('203.0.113.1', { page: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
  });

  it('counts a page of any kind', async () => {
    const venue = await insertPage('venue', 'iclr/2027');
    const cookie = await signUp('reader@ethz.ch');
    expect((await view('203.0.113.1', { page: venue.id, cookie })).body).toEqual({ views: 1, shown: false });
  });

  it('counts a transition once a day per visitor and pair, and ignores a bad from', async () => {
    pageId = await paper();
    const venue = await insertPage('venue', 'iclr/2027');
    await view('203.0.113.1', { from: venue.id });
    await view('203.0.113.1', { from: venue.id });
    await view('203.0.113.2', { from: venue.id });
    expect((await view('203.0.113.3', { from: 'not-a-page' })).status).toBe(200);
    expect((await view('203.0.113.4', { from: pageId })).status).toBe(200);
    const rows = await getDb().select().from(pageTransitions);
    expect(rows).toEqual([{ fromPageId: venue.id, toPageId: pageId, count: 2 }]);
    expect(await countTransition('00000000-0000-4000-8000-000000000000', pageId, { ip: '203.0.113.5' })).toBe(false);
  });

  it('gives the number to signed-in readers only, and says when there are enough to show', async () => {
    pageId = await paper();
    for (let i = 1; i < 10; i++) await view(`203.0.113.${i}`);
    expect((await view('203.0.113.200')).body).toEqual({ views: null, shown: true });
    const cookie = await signUp('reader@ethz.ch');
    expect((await view('203.0.113.201', { cookie })).body).toEqual({ views: 11, shown: true });
  });
});

describe('GET /transitions', () => {
  it('lists pairs by page identifier, for admins only', async () => {
    pageId = await paper();
    const venue = await insertPage('venue', 'iclr/2027');
    await view('203.0.113.1', { from: venue.id });
    const cookie = await signUp('reader@ethz.ch');
    expect((await api('GET', '/transitions', { cookie })).status).toBe(403);
    const before = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = 'admin@ethz.ch';
    try {
      const admin = await signUp('admin@ethz.ch');
      expect((await api('GET', '/transitions', { cookie: admin })).body).toEqual({
        transitions: [{ from: 'venue:iclr/2027', to: 'arxiv:1706.03762', count: 1 }],
      });
    } finally {
      process.env.ADMIN_EMAILS = before;
    }
  });
});
