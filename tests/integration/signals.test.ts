import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { storePluginFiles } from '@/server/plugins/snapshot';
import { mintToken } from '@/server/tokens';
import { api, closePool, resetDatabase, signUp } from './helpers';

/**
 * Signals (`handoffs/signals.md`): a set registered from its manifest by its publisher, values written into the live
 * generation or a staged one that is then published at once, and the public reads a map plugin makes.
 */

const OWNER = 'benedict-armstrong';
const REPO = 'acceptodds-map';
const SET = `${OWNER}/acceptodds-map`;
const COMMIT = 'a'.repeat(40);
const SOURCE = `github:${OWNER}/${REPO}@${COMMIT}`;

const manifest = (publisher: string, extra: Record<string, unknown>[] = []) => ({
  id: SET,
  name: 'acceptodds map',
  version: '0.1.0',
  apiVersion: 1,
  main: 'index.html',
  publisher,
  contributes: {
    signals: [
      { id: 'map.xy', kind: 'vector', dims: 2, title: 'Position' },
      { id: 'map.region', kind: 'label', title: 'Region' },
      { id: 'embedding', kind: 'vector', dims: 3, title: 'Embedding' },
      ...extra,
    ],
  },
});

async function store(publisher: string, commit = COMMIT, extra: Record<string, unknown>[] = []) {
  await storePluginFiles({ kind: 'github', owner: OWNER, repo: REPO, path: '', ref: null }, commit, [
    { path: 'potentialpaper-plugin.json', bytes: Buffer.from(JSON.stringify(manifest(publisher, extra))) },
    { path: 'index.html', bytes: Buffer.from('<!doctype html><title>set</title>') },
  ]);
}

async function paper(id: string, title: string) {
  const db = getDb();
  const { rows } = await db.execute<{ id: string }>(
    sql`insert into papers (title, source) values (${title}, 'openreview') returning id`,
  );
  await db.execute(
    sql`insert into paper_identifiers (scheme, value, paper_id) values ('openreview', ${id}, ${rows[0].id})`,
  );
  return rows[0].id;
}

async function publisher(email: string, handle: string) {
  const cookie = await signUp(email);
  const db = getDb();
  const [account] = await db
    .select()
    .from(accounts)
    .orderBy(sql`created_at desc`)
    .limit(1);
  await db.update(accounts).set({ handle }).where(eq(accounts.id, account.id));
  const { token } = await mintToken({ account: { ...account, handle }, name: 'publisher', scopes: ['read', 'write'] });
  return { cookie, token };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'signals-'));
  process.env.DEMOS_DIR = dir;
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await closePool();
});
beforeEach(resetDatabase);

describe('signals', () => {
  it('registers a set only for the publisher its manifest names', async () => {
    await store('ben');
    const ada = await publisher('ada@ethz.ch', 'ada');
    const refused = await api('POST', '/signal-sets', { token: ada.token, body: { source: SOURCE } });
    expect(refused.status).toBe(403);

    const ben = await publisher('ben@ethz.ch', 'ben');
    const made = await api('POST', '/signal-sets', { token: ben.token, body: { source: SOURCE } });
    expect(made.status).toBe(201);
    expect(made.body.signals.map((s: { name: string }) => s.name)).toEqual(['embedding', 'map.region', 'map.xy']);
    expect((await api('GET', '/signal-sets')).body.sets).toEqual([
      { id: SET, name: 'acceptodds map', description: null, publisher: 'ben' },
    ]);

    // Nobody else writes its values.
    const write = await api('PUT', `/signal-sets/${SET}/values`, {
      token: ada.token,
      body: { values: [{ paper: 'openreview:abcdef', signal: 'map.xy', value: [1, 2] }] },
    });
    expect(write.status).toBe(403);
  });

  it('checks values against their signals, reporting every problem', async () => {
    await store('ben');
    const ben = await publisher('ben@ethz.ch', 'ben');
    await api('POST', '/signal-sets', { token: ben.token, body: { source: SOURCE } });
    const bad = await api('PUT', `/signal-sets/${SET}/values`, {
      token: ben.token,
      body: {
        values: [
          { paper: 'openreview:abcdef', signal: 'map.xy', value: [1, 2, 3] },
          { paper: 'nonsense', signal: 'map.xy', value: [1, 2] },
          { paper: 'openreview:abcdef', signal: 'nope', value: 1 },
        ],
      },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message.split('\n')).toHaveLength(3);
  });

  it('serves columns of papers it has, swaps a staged generation in at once, and finds nearest papers', async () => {
    await store('ben');
    const ben = await publisher('ben@ethz.ch', 'ben');
    await api('POST', '/signal-sets', { token: ben.token, body: { source: SOURCE } });
    await paper('aaaaaa', 'Paper A');
    await paper('bbbbbb', 'Paper B');
    await paper('cccccc', 'Paper C');

    const values = [
      { paper: 'openreview:aaaaaa', signal: 'map.xy', value: [0, 0] },
      { paper: 'openreview:bbbbbb', signal: 'map.xy', value: [1, 1] },
      { paper: 'openreview:cccccc', signal: 'map.xy', value: [5, 5] },
      // Not a paper here yet: kept, and left out of reads until it is.
      { paper: 'openreview:zzzzzz', signal: 'map.xy', value: [9, 9] },
      { paper: 'openreview:aaaaaa', signal: 'map.region', value: 'r1' },
      { paper: 'openreview:bbbbbb', signal: 'map.region', value: 'r1' },
      { paper: 'openreview:cccccc', signal: 'map.region', value: 'r2' },
      { paper: 'openreview:aaaaaa', signal: 'embedding', value: [1, 0, 0] },
      { paper: 'openreview:bbbbbb', signal: 'embedding', value: [0.9, 0.1, 0] },
      { paper: 'openreview:cccccc', signal: 'embedding', value: [0, 0, 1] },
    ];
    expect((await api('PUT', `/signal-sets/${SET}/values`, { token: ben.token, body: { values } })).status).toBe(200);
    await api('PUT', `/signal-sets/${SET}/labels`, {
      token: ben.token,
      body: { signal: 'map.region', labels: [{ key: 'r1', title: 'agents' }] },
    });

    const columns = (await api('GET', `/signal-sets/${SET}/columns?signals=map.xy,map.region&titles=true`)).body;
    expect(columns.papers).toEqual(['openreview:aaaaaa', 'openreview:bbbbbb', 'openreview:cccccc']);
    expect(columns.titles).toEqual(['Paper A', 'Paper B', 'Paper C']);
    expect(columns.signals['map.xy']).toEqual({ kind: 'vector', dims: 2, values: [0, 0, 1, 1, 5, 5] });
    expect(columns.signals['map.region']).toEqual({
      kind: 'label',
      keys: ['r1', 'r2'],
      titles: ['agents', null],
      values: [0, 0, 1],
    });

    const near = (await api('GET', `/signal-sets/${SET}/nearest?signal=embedding&paper=openreview%3Aaaaaaa&k=2`)).body;
    expect(near.neighbours.map((n: { paper: string }) => n.paper)).toEqual(['openreview:bbbbbb', 'openreview:cccccc']);

    // A rebuild: staged, written, and invisible until published.
    const staged = await api('POST', `/signal-sets/${SET}/generations`, { token: ben.token });
    expect(staged.body).toEqual({ generation: 2, live: 1 });
    await api('PUT', `/signal-sets/${SET}/values?generation=2`, {
      token: ben.token,
      body: { values: [{ paper: 'openreview:aaaaaa', signal: 'map.xy', value: [7, 7] }] },
    });
    let xy = (await api('GET', `/signal-sets/${SET}/columns?signals=map.xy`)).body;
    expect(xy.signals['map.xy'].values).toEqual([0, 0, 1, 1, 5, 5]);
    expect((await api('POST', `/signal-sets/${SET}/generations/2/publish`, { token: ben.token })).status).toBe(200);
    xy = (await api('GET', `/signal-sets/${SET}/columns?signals=map.xy`)).body;
    expect(xy.papers).toEqual(['openreview:aaaaaa']);
    expect(xy.signals['map.xy'].values).toEqual([7, 7]);
    expect(xy.set.generation).toBe(2);

    const mine = (await api('GET', '/pages/openreview%3Aaaaaaa/signals')).body;
    expect(mine.sets).toEqual([
      { id: SET, name: 'acceptodds map', values: { 'map.xy': { kind: 'vector', value: [7, 7] } } },
    ]);
  });

  it('drops the values of a signal its manifest no longer declares', async () => {
    await store('ben', COMMIT, [{ id: 'rigour', kind: 'number', min: 0, max: 1, title: 'Rigour' }]);
    const ben = await publisher('ben@ethz.ch', 'ben');
    await api('POST', '/signal-sets', { token: ben.token, body: { source: SOURCE } });
    await paper('aaaaaa', 'Paper A');
    const out = await api('PUT', `/signal-sets/${SET}/values`, {
      token: ben.token,
      body: { values: [{ paper: 'openreview:aaaaaa', signal: 'rigour', value: 2 }] },
    });
    expect(out.status).toBe(400);
    await api('PUT', `/signal-sets/${SET}/values`, {
      token: ben.token,
      body: { values: [{ paper: 'openreview:aaaaaa', signal: 'rigour', value: 0.5 }] },
    });
    const next = 'b'.repeat(40);
    await store('ben', next);
    await api('POST', '/signal-sets', { token: ben.token, body: { source: `github:${OWNER}/${REPO}@${next}` } });
    const { rows } = await getDb().execute(sql`select count(*)::int as n from signal_values where signal = 'rigour'`);
    expect(rows[0].n).toBe(0);
  });
});
