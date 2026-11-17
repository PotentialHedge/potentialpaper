import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { papers, paperViews } from '@/db/schema';
import { savePaper } from '@/server/papers';
import { countView } from '@/server/view-counter';
import { api, closePool, resetDatabase, signUp } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

const PAPER = { scheme: 'arxiv', value: '1706.03762' } as const;

function paper(): Promise<string> {
  return savePaper({
    title: 'Attention Is All You Need',
    authors: ['Ashish Vaswani'],
    abstract: null,
    year: 2017,
    venue: null,
    identifiers: [PAPER],
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: null,
  });
}

const view = (ip: string, opts: { cookie?: string; paper?: { scheme: string; value: string } } = {}) =>
  api('POST', '/views', {
    cookie: opts.cookie,
    body: { paper: opts.paper ?? PAPER },
    headers: { 'cf-connecting-ip': ip },
  });

describe('POST /views', () => {
  it('counts a visitor once a day, and a different visitor again', async () => {
    const id = await paper();
    expect((await view('203.0.113.1')).body).toEqual({ views: 1 });
    expect((await view('203.0.113.1')).body).toEqual({ views: 1 });
    expect((await view('203.0.113.2')).body).toEqual({ views: 2 });
    const [row] = await getDb().select({ n: papers.viewCount }).from(papers).where(eq(papers.id, id));
    expect(row.n).toBe(2);
  });

  it('counts an IPv6 /64 once, whichever address in it sends', async () => {
    await paper();
    await view('2001:db8:1:2::1');
    await view('2001:db8:1:2:ffff:ffff:ffff:ffff');
    expect((await view('2001:db8:1:3::1')).body.views).toBe(2);
  });

  it('counts each signed-in account once, apart from its network', async () => {
    await paper();
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
    const rows = await getDb().select().from(paperViews);
    expect(rows).toHaveLength(2);
    expect(rows[0].visitor).not.toBe(rows[1].visitor);
    expect(JSON.stringify(rows)).not.toContain('203.0.113.1');
  });

  it('is a 404 for an unknown paper', async () => {
    expect((await view('203.0.113.1', { paper: { scheme: 'arxiv', value: '2101.00001' } })).status).toBe(404);
  });
});
