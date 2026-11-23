import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { mergePapers } from '@/server/merge-papers';
import { SYSTEM_ACTOR } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { api, closePool, commitFiles, resetDatabase, signUp } from './helpers';

/**
 * The events feed for publishers (`server/events-feed.ts`): every commit, oldest first, from a cursor that never skips
 * one; a paper's creation and a merge said as such; `now` to start at the present, and `wait` to hold on for the next.
 */

let cookie = '';
const ids = new Map<string, string>();

/** A paper, and its page's first commit (`created`), as its first edit makes it. */
async function paper(value: string, title: string): Promise<string> {
  const id = await savePaper({
    title,
    authors: [],
    abstract: 'An abstract.',
    identifiers: [{ scheme: 'openreview', value }],
    source: 'openreview',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
  });
  ids.set(id, value);
  await edit(id, `${title}, summarised.`, 'Start');
  return id;
}

async function edit(id: string, text: string, message = 'Summarise') {
  const paper = { scheme: 'openreview', value: ids.get(id)! };
  const res = await commitFiles(
    cookie,
    paper,
    await readHead(getDb(), id),
    { 'community/10-summary.md': text },
    message,
  );
  expect(res.status).toBe(200);
}

type Event = {
  cursor: string;
  created: boolean;
  summary: string;
  paths: string[];
  page: { identifier: string; identifiers?: string[] };
  merged?: { identifier: string | null; identifiers: string[] };
};

/** Every event from `after`, a page of `limit` at a time. */
async function all(after = '', limit = 100): Promise<{ events: Event[]; next: string }> {
  const events: Event[] = [];
  let cursor = after;
  for (;;) {
    const res = await api('GET', `/events?kind=paper&limit=${limit}${cursor ? `&after=${cursor}` : ''}`);
    expect(res.status).toBe(200);
    events.push(...res.body.events);
    cursor = res.body.next;
    if (!res.body.more) return { events, next: cursor };
  }
}

beforeEach(async () => {
  await resetDatabase();
  cookie = await signUp('ada@ethz.ch');
});
afterAll(closePool);

describe('the events feed', () => {
  it('gives every commit oldest first, in pages, and nothing again after the cursor', async () => {
    const a = await paper('aaaaaaaa', 'Paper A');
    await paper('bbbbbbbb', 'Paper B');
    await edit(a, 'A summary.');

    const whole = await all();
    expect(whole.events.map((e) => [e.page.identifier, e.created, e.summary])).toEqual([
      ['openreview:aaaaaaaa', true, 'Start'],
      ['openreview:bbbbbbbb', true, 'Start'],
      ['openreview:aaaaaaaa', false, 'Summarise'],
    ]);
    expect(whole.events[0].page.identifiers).toEqual(['openreview:aaaaaaaa']);
    expect(whole.events[2].paths).toEqual(['community/10-summary.md']);

    // One at a time, the same events in the same order.
    const paged = await all('', 1);
    expect(paged.events.map((e) => e.cursor)).toEqual(whole.events.map((e) => e.cursor));

    // After the cursor: nothing, until something new.
    expect((await all(whole.next)).events).toEqual([]);
    await edit(a, 'A better summary.');
    const after = await all(whole.next);
    expect(after.events.map((e) => e.summary)).toEqual(['Summarise']);
  });

  it('starts at the present with `now`, and filters by kind', async () => {
    await paper('aaaaaaaa', 'Paper A');
    const now = await api('GET', '/events?after=now');
    expect(now.body).toMatchObject({ events: [], more: false });
    const b = await paper('bbbbbbbb', 'Paper B');
    const since = await all(now.body.next);
    expect(since.events.map((e) => e.page.identifier)).toEqual(['openreview:bbbbbbbb']);
    expect((await api('GET', '/events?kind=venue')).body.events).toEqual([]);
    expect((await api('GET', '/events?kind=paper')).body.events.length).toBeGreaterThan(0);
    expect((await api('GET', '/events?after=nonsense')).status).toBe(400);
    expect(b).toBeTruthy();
  });

  it('says which paper a merge folded in', async () => {
    const old = await paper('oldoldold', 'Concept Component Analysis');
    const kept = await paper('newnewnew', 'Concept Component Analysis');
    const before = await all();
    await mergePapers({ duplicateId: old, survivorId: kept, from: 'openreview:oldoldold' }, SYSTEM_ACTOR);
    const merge = (await all(before.next)).events.find((e) => e.merged);
    expect(merge).toMatchObject({
      page: { identifier: 'openreview:newnewnew' },
      merged: { identifiers: ['openreview:oldoldold'] },
    });
  });

  it('waits for the next commit with `wait`, and gives up when the time is up', async () => {
    const a = await paper('aaaaaaaa', 'Paper A');
    const { next } = await all();
    const started = Date.now();
    const empty = await api('GET', `/events?after=${next}&wait=1`);
    expect(empty.body.events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    const waiting = api('GET', `/events?after=${next}&wait=10`);
    await new Promise((r) => setTimeout(r, 300));
    await edit(a, 'News.');
    const woken = await waiting;
    expect(woken.body.events.map((e: Event) => e.summary)).toEqual(['Summarise']);
    expect(Date.now() - started).toBeLessThan(8_000);
  });
});
