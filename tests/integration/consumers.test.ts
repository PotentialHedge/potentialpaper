import { eq } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts, consumerCursors } from '@/db/schema';
import type { Consumer } from '@/server/consumers';
import { rebuildConsumer, runConsumer } from '@/server/consumers/run';
import { runWorker } from '@/server/consumers/worker';
import { type Actor, commitPage } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { savePaper } from '@/server/papers';
import { closePool, resetDatabase } from './helpers';

beforeEach(resetDatabase);
afterAll(closePool);

const NO_LIMIT = { burst: 100_000, perSecond: 1000 };

let count = 0;
async function newPaper(): Promise<string> {
  count += 1;
  return savePaper({
    title: `Paper ${count}`,
    authors: ['Ada Lovelace'],
    abstract: 'An abstract.',
    year: 2020,
    venue: null,
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [{ scheme: 'arxiv', value: `2101.${String(count).padStart(5, '0')}` }],
  });
}

async function newAccount(): Promise<Actor> {
  count += 1;
  const [row] = await getDb()
    .insert(accounts)
    .values({ handle: `person-${count}`, verifiedAt: new Date() })
    .returning({ id: accounts.id });
  return { kind: 'account', accountId: row.id, isAdmin: false };
}

async function edit(paperId: string, person: Actor, text: string): Promise<string> {
  const result = await commitPage(
    paperId,
    await readHead(getDb(), paperId),
    person,
    [{ path: 'community/10-summary.md', content: `# Summary\n\n${text}\n` }],
    text,
    { rateLimit: NO_LIMIT },
  );
  if (result.status !== 'committed') throw new Error('nothing committed');
  return result.oid;
}

/** A consumer that records what it was handed, and can be made to fail for a page. */
function recorder(name = 'test') {
  const calls: [string, string][] = [];
  const failing = new Set<string>();
  let resets = 0;
  const consumer: Consumer = {
    name,
    async handle(paperId, head) {
      if (failing.has(paperId)) throw new Error('boom');
      calls.push([paperId, head]);
    },
    async reset() {
      resets += 1;
    },
  };
  return { consumer, calls, failing, resets: () => resets };
}

/** A connection of its own, to hold a transaction open across other writes. */
async function connection(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

/** An event written by hand, as `recordCommit` writes one, in whatever transaction `client` is in. */
async function insertEvent(client: Client, paperId: string, seq: number, oid: string): Promise<void> {
  await client.query(`insert into page_events (paper_id, seq, type, payload) values ($1, $2, 'page.committed', $3)`, [
    paperId,
    seq,
    JSON.stringify({ oid }),
  ]);
}

async function cursor(name: string) {
  const [row] = await getDb().select().from(consumerCursors).where(eq(consumerCursors.name, name));
  return row;
}

describe('outbox consumers', () => {
  it('hands each page over once, at its newest head, and nothing again once caught up', async () => {
    const person = await newAccount();
    const [a, b] = [await newPaper(), await newPaper()];
    await edit(a, person, 'one');
    await edit(b, person, 'two');
    const aHead = await edit(a, person, 'three');
    const bHead = await readHead(getDb(), b);

    const { consumer, calls } = recorder();
    const report = await runConsumer(consumer);
    expect(report).toMatchObject({ status: 'caught-up', events: 3, pages: 2 });
    expect(calls).toEqual([
      [a, aHead],
      [b, bHead],
    ]);

    expect(await runConsumer(consumer)).toMatchObject({ status: 'caught-up', events: 0, pages: 0 });
    const newer = await edit(b, person, 'four');
    expect(await runConsumer(consumer)).toMatchObject({ events: 1, pages: 1 });
    expect(calls.at(-1)).toEqual([b, newer]);
  });

  it('reads in batches, each page once per batch', async () => {
    const person = await newAccount();
    const paperId = await newPaper();
    const heads: string[] = [];
    for (let i = 0; i < 5; i += 1) heads.push(await edit(paperId, person, `edit ${i}`));

    const { consumer, calls } = recorder();
    const report = await runConsumer(consumer, { batchSize: 2 });
    expect(report).toMatchObject({ status: 'caught-up', events: 5, pages: 3 });
    expect(calls.map(([, head]) => head)).toEqual([heads[1], heads[3], heads[4]]);
  });

  it('never steps past an event whose transaction is still open, though a later one is committed', async () => {
    const [early, late] = [await newPaper(), await newPaper()];
    const { consumer, calls } = recorder();
    const slow = await connection();
    try {
      // The slow commit takes the lower id, and commits last.
      await slow.query('begin');
      await insertEvent(slow, early, 1, 'a'.repeat(40));
      const quick = await connection();
      await insertEvent(quick, late, 1, 'b'.repeat(40));
      await quick.end();

      // A cursor on ids would take the quick one now and never see the slow one.
      expect(await runConsumer(consumer)).toMatchObject({ events: 0, pages: 0 });
      expect(calls).toEqual([]);

      await slow.query('commit');
      expect(await runConsumer(consumer)).toMatchObject({ events: 2, pages: 2 });
      expect(calls).toEqual([
        [early, 'a'.repeat(40)],
        [late, 'b'.repeat(40)],
      ]);
    } finally {
      await slow.end();
    }
  });

  it('follows transactions, not ids: an older transaction with a higher id comes first', async () => {
    const [first, second] = [await newPaper(), await newPaper()];
    const { consumer, calls } = recorder();
    const older = await connection();
    try {
      await older.query('begin');
      await older.query('select pg_current_xact_id()');
      const newer = await connection();
      await insertEvent(newer, second, 1, 'c'.repeat(40)); // lower id, newer transaction
      await newer.end();
      await insertEvent(older, first, 1, 'd'.repeat(40)); // higher id, older transaction

      expect(await runConsumer(consumer)).toMatchObject({ events: 0 });
      await older.query('commit');
      expect(await runConsumer(consumer)).toMatchObject({ events: 2 });
      expect(calls).toEqual([
        [first, 'd'.repeat(40)],
        [second, 'c'.repeat(40)],
      ]);
    } finally {
      await older.end();
    }
  });

  it('stops at a failing page, keeps the error, waits, and goes on once it passes', async () => {
    const person = await newAccount();
    const [a, b, c] = [await newPaper(), await newPaper(), await newPaper()];
    await edit(a, person, 'a');
    await edit(b, person, 'b');
    await edit(a, person, 'a again');
    await edit(c, person, 'c');

    const { consumer, calls, failing } = recorder();
    failing.add(b);
    const failed = await runConsumer(consumer);
    expect(failed).toMatchObject({ status: 'failed', events: 1, pages: 1 });
    expect(failed.error).toContain(`page ${b}`);
    expect(calls.map(([paperId]) => paperId)).toEqual([a]);
    expect((await cursor('test')).lastError).toContain('boom');

    failing.delete(b);
    expect(await runConsumer(consumer)).toMatchObject({ status: 'waiting', events: 0 });
    const report = await runConsumer(consumer, { retryNow: true });
    expect(report).toMatchObject({ status: 'caught-up', events: 3 });
    // `a` again, harmlessly: its second event comes after `b`'s.
    expect(calls.map(([paperId]) => paperId)).toEqual([a, b, a, c]);
    expect((await cursor('test')).lastError).toBeNull();
  });

  it('lets one worker at a time run a consumer, and a rebuild stops the one running', async () => {
    const person = await newAccount();
    const paperId = await newPaper();
    await edit(paperId, person, 'one');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const slow: Consumer = {
      name: 'test',
      async handle() {
        entered();
        await gate;
      },
    };
    const running = runConsumer(slow);
    await inside;
    expect(await runConsumer(recorder().consumer)).toMatchObject({ status: 'busy' });

    await rebuildConsumer(slow);
    release();
    expect(await running).toMatchObject({ status: 'lease-lost', events: 0 });
    expect(await cursor('test')).toMatchObject({ lastEventId: 0, leasedUntil: null });
  });

  it('rebuilds from zero: clears, then replays every event', async () => {
    const person = await newAccount();
    const paperId = await newPaper();
    const head = await edit(paperId, person, 'one');
    const { consumer, calls, resets } = recorder();
    await runConsumer(consumer);
    expect(await runConsumer(consumer)).toMatchObject({ events: 0 });

    await rebuildConsumer(consumer);
    expect(resets()).toBe(1);
    expect(await runConsumer(consumer)).toMatchObject({ events: 1, pages: 1 });
    expect(calls).toEqual([
      [paperId, head],
      [paperId, head],
    ]);
  });

  it('notifies on commit, and the worker wakes for it long before its poll', async () => {
    const person = await newAccount();
    const paperId = await newPaper();
    const { consumer, calls } = recorder();
    const controller = new AbortController();
    let passes = 0;
    let passed!: () => void;
    let firstPass = new Promise<void>((resolve) => (passed = resolve));
    const worker = runWorker({
      consumers: [consumer],
      listenUrl: process.env.DATABASE_URL,
      pollMs: 60_000,
      signal: controller.signal,
      onPass: () => {
        passes += 1;
        passed();
      },
    });
    try {
      await firstPass;
      // Give the LISTEN a moment to be in place.
      await new Promise((resolve) => setTimeout(resolve, 300));
      firstPass = new Promise<void>((resolve) => (passed = resolve));
      const head = await edit(paperId, person, 'wake up');
      await Promise.race([
        firstPass,
        new Promise((_, reject) => setTimeout(() => reject(new Error('the worker never woke')), 5_000)),
      ]);
      expect(passes).toBeGreaterThanOrEqual(2);
      expect(calls).toContainEqual([paperId, head]);
    } finally {
      controller.abort();
      await worker;
    }
  });
});
