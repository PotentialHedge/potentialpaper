import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/db';
import { memoryRepo, pageRepo, type WritableGitRepo } from '@/server/git/repo';
import { moveHead } from '@/server/pages/commit';
import { buildTrees, encodeCommit, gitObject } from '@/server/pages/git-objects';
import { savePaper } from '@/server/papers';
import { closePool, resetDatabase } from './helpers';

/**
 * The object store interface (DESIGN.md §4.11): the same checks against the repo in memory and the one in
 * Postgres, so either can stand in for the other.
 */

beforeEach(resetDatabase);
afterAll(closePool);

const blob = gitObject('blob', Buffer.from('Hello\n'));
const { root, trees } = buildTrees(new Map([['community/10-summary.md', blob.oid]]));
const commit = gitObject(
  'commit',
  encodeCommit({
    tree: root,
    parent: null,
    authorId: 'u_test',
    at: new Date(1_700_000_000_000),
    summary: 'First',
    kind: 'edit',
  }),
);
const objects = [blob, ...trees, commit];

let papers = 0;
function paperId(): Promise<string> {
  papers += 1;
  return savePaper({
    title: 'A paper',
    authors: ['Ada Lovelace'],
    abstract: 'An abstract.',
    source: 'arxiv',
    metadataLicense: 'CC0-1.0',
    abstractLicense: 'CC0-1.0',
    identifiers: [{ scheme: 'arxiv', value: `2001.${String(papers).padStart(5, '0')}` }],
  });
}

const stores: [string, () => Promise<{ repo: WritableGitRepo; setHead: (oid: string) => Promise<unknown> }>][] = [
  [
    'memory',
    async () => {
      let head: string | null = null;
      const repo = memoryRepo(null, new Map());
      return {
        repo: { ...repo, head: async () => head },
        setHead: async (oid) => (head = oid),
      };
    },
  ],
  [
    'postgres',
    async () => {
      const id = await paperId();
      return { repo: pageRepo(getDb(), id), setHead: (oid) => moveHead(getDb(), id, null, oid) };
    },
  ],
];

describe.each(stores)('GitRepo in %s', (_, open) => {
  it('is empty before anything is written', async () => {
    const { repo } = await open();
    expect(await repo.head()).toBeNull();
    expect(await repo.read(objects.map((o) => o.oid))).toEqual(new Map());
    expect(await repo.sizes(objects.map((o) => o.oid))).toEqual(new Map());
    expect(await Array.fromAsync(repo.commits())).toEqual([]);
  });

  it('reads back what it wrote, and writing it again changes nothing', async () => {
    const { repo, setHead } = await open();
    await repo.write(objects);
    await repo.write([blob, commit]);
    await repo.write([]);
    await setHead(commit.oid);

    expect(await repo.head()).toBe(commit.oid);
    const read = await repo.read([...objects.map((o) => o.oid), '0'.repeat(40)]);
    expect(read).toEqual(new Map(objects.map(({ oid, type, body }) => [oid, { type, body }])));
    expect(await repo.sizes([blob.oid, commit.oid, '0'.repeat(40)])).toEqual(
      new Map([
        [blob.oid, blob.body.length],
        [commit.oid, commit.body.length],
      ]),
    );
    expect(await Array.fromAsync(repo.commits())).toEqual([{ oid: commit.oid, body: commit.body }]);
  });
});

it("keeps one page's objects from another's", async () => {
  const [first, second] = [await paperId(), await paperId()];
  await pageRepo(getDb(), first).write(objects);
  expect(await pageRepo(getDb(), second).read([blob.oid])).toEqual(new Map());
  expect(await pageRepo(getDb(), second).sizes([blob.oid])).toEqual(new Map());
});
