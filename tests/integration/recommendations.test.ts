import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { followPaper } from '@/server/follows';
import { canRecommend, recommendationScores } from '@/server/recommendations';
import { searchPapers } from '@/server/search';
import { closePool, resetDatabase, signUp } from './helpers';

/**
 * The home page's recommended sort (`server/recommendations.ts`): papers near the ones the viewer acted on, by the
 * site's vector signal, co-reading and links, never the acted-on papers themselves.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const SET = 'benedict-armstrong/acceptodds-map';

async function paper(key: string, vec?: number[]): Promise<string> {
  const db = getDb();
  const { rows } = await db.execute<{ id: string }>(
    sql`insert into papers (title, source) values (${`Paper ${key}`}, 'openreview') returning id`,
  );
  const id = rows[0].id;
  await db.execute(sql`insert into paper_identifiers (scheme, value, paper_id) values ('openreview', ${key}, ${id})`);
  if (vec) {
    await db.execute(sql`insert into signal_values (set_id, generation, signal, scheme, value, vec)
                         values (${SET}, 1, 'embedding', 'openreview', ${key}, ${`{${vec.join(',')}}`}::real[])`);
  }
  return id;
}

async function viewer(): Promise<string> {
  await signUp('ada@ethz.ch');
  const [account] = await getDb().select().from(accounts);
  return account.id;
}

async function vectorSet(publisherId: string) {
  const db = getDb();
  await db.execute(sql`insert into signal_sets (id, source, commit, publisher_id, name)
                       values (${SET}, ${`github:${SET}`}, ${'a'.repeat(40)}, ${publisherId}, 'map')`);
  await db.execute(sql`insert into signals (set_id, name, kind, spec)
                       values (${SET}, 'embedding', 'vector', ${JSON.stringify({ id: 'embedding', kind: 'vector', dims: 2, metric: 'cosine' })}::jsonb)`);
}

describe('recommendations', () => {
  it('offers the sort once the viewer has done enough', async () => {
    const me = await viewer();
    const [a, b] = [await paper('a'), await paper('b')];
    expect(await canRecommend(me)).toBe(false);
    await followPaper(a, me);
    expect(await canRecommend(me)).toBe(false);
    await followPaper(b, me);
    expect(await canRecommend(me)).toBe(true);
  });

  it('scores papers near the viewer’s, by vector, co-reading and links, and lists them first', async () => {
    const me = await viewer();
    await vectorSet(me);
    const followed = await paper('followed', [1, 0]);
    const near = await paper('near', [0.95, 0.05]);
    const far = await paper('far', [-1, 0]);
    const coread = await paper('coread');
    const linked = await paper('linked');
    await paper('unrelated');
    await followPaper(followed, me);

    const db = getDb();
    await db.execute(
      sql`insert into page_transitions (from_page_id, to_page_id, count) values (${followed}, ${coread}, 4)`,
    );
    await db.execute(sql`insert into page_links (page_id, path, link_id, line, target, target_kind, target_page_id, label, origin)
                         values (${linked}, 'paper.md', 'x', 1, 'openreview:followed', 'paper', ${followed}, 'cites', 'owners')`);

    const scores = await recommendationScores(me, db);
    expect(scores.has(followed)).toBe(false);
    for (const id of [near, coread, linked]) expect(scores.get(id)).toBeGreaterThan(0);
    // The farther neighbour still counts, below the nearer one.
    expect(scores.get(near)!).toBeGreaterThan(scores.get(far) ?? 0);

    const { hits } = await searchPapers({ sort: 'title', recommendScores: scores, exceptFollowedBy: me }, db);
    const titles = hits.map((h) => h.title);
    // The four scored papers first, then the rest by the sort asked for.
    expect(titles.slice(0, 4).sort()).toEqual(['Paper coread', 'Paper far', 'Paper linked', 'Paper near']);
    expect(titles.slice(4)).toEqual(['Paper unrelated']);
  });

  it('is empty for a viewer who has done nothing', async () => {
    const me = await viewer();
    await paper('a');
    expect((await recommendationScores(me, getDb())).size).toBe(0);
  });
});
