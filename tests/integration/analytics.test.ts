import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, authorClaims } from '@/db/schema';
import { decideClaim } from '@/server/claims';
import { countDaily, countInstitution, MIN_INSTITUTION_VISITORS } from '@/server/page-analytics';
import { savePaper } from '@/server/papers';
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

async function author(paperId: string): Promise<string> {
  const cookie = await signUp('ashish@ethz.ch');
  await api('POST', '/claims', { cookie, body: { paper: PAPER, authorIndex: 0 } });
  const [claim] = await getDb().select().from(authorClaims).where(eq(authorClaims.paperId, paperId));
  await decideClaim(claim.id, 'confirmed', null);
  return cookie;
}

const today = () => new Date().toISOString().slice(0, 10);

describe('GET /analytics', () => {
  it("shows a paper's analytics to its confirmed authors only", async () => {
    const id = await paper();
    expect((await api('GET', `/analytics?page=${id}`)).status).toBe(401);
    const reader = await signUp('reader@mit.edu');
    expect((await api('GET', `/analytics?page=${id}`, { cookie: reader })).status).toBe(403);
    const cookie = await author(id);
    const res = await api('GET', `/analytics?page=${id}`, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(90);
  });

  it('counts views, git and time by day, each visitor once a day', async () => {
    const id = await paper();
    const cookie = await author(id);
    const headers = { 'cf-connecting-ip': '203.0.113.1' };
    await api('POST', '/views', { body: { page: id }, headers });
    await api('POST', '/views', { body: { page: id }, headers });
    await api('POST', '/views', { body: { page: id }, headers: { 'cf-connecting-ip': '203.0.113.2' } });
    expect(await countDaily(id, 'git', 'git', { ip: '203.0.113.1' })).toBe(true);
    expect(await countDaily(id, 'git', 'git', { ip: '203.0.113.1' })).toBe(false);
    const time = (seconds: number) =>
      api('POST', '/views/time', { text: JSON.stringify({ page: id, seconds }), headers });
    expect((await time(75)).status).toBe(204);
    await time(5);
    expect((await api('POST', '/views/time', { text: 'nonsense', headers })).status).toBe(400);

    const { body } = await api('GET', `/analytics?page=${id}`, { cookie });
    const day = body.days.find((d: { day: string }) => d.day === today());
    // The author's own sign-in visit is not one: they never viewed it.
    expect(day).toEqual({ day: today(), views: 2, git: 1, agent: 0 });
    expect(body.totalViews).toBe(2);
    // 75 s is the 1–2 min bucket; the second report of the day is not counted.
    expect(body.time).toEqual([0, 0, 0, 1, 0, 0, 0]);
  });

  it('shows an institution only once enough of its people read the page in a month', async () => {
    const id = await paper();
    const cookie = await author(id);
    const ids: string[] = [];
    for (let i = 0; i < MIN_INSTITUTION_VISITORS; i += 1) {
      const [row] = await getDb()
        .insert(accounts)
        .values({ handle: `reader${i}`, institutions: ['University of Cambridge'] })
        .returning({ id: accounts.id });
      ids.push(row.id);
    }
    const institutions = async () => (await api('GET', `/analytics?page=${id}`, { cookie })).body.institutions;
    for (const accountId of ids.slice(0, -1)) await countInstitution(id, accountId);
    // The same person again this month counts once.
    await countInstitution(id, ids[0]);
    expect(await institutions()).toEqual([]);
    await countInstitution(id, ids[ids.length - 1]);
    expect(await institutions()).toEqual([{ name: 'University of Cambridge', visitors: MIN_INSTITUTION_VISITORS }]);
  });
});
