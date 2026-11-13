import type { GitObjectType } from '../pages/git-objects';
import { parseTree } from '../pages/git-objects';
import type { GitRepo } from './repo';

/**
 * Which objects a fetch sends: everything reachable from what the client wants, less what it already has.
 * Commits come from one pass over the repo's commit rows (small, and a page's history is short); trees are
 * read a level at a time, a batch per query; blobs are never read here, only named by their trees.
 */

/** Messages meant for the client, sent as `ERR` (or on the error band once a pack has started). */
export class FetchError extends Error {}

/** More than any page should have; past these a fetch is refused rather than held in memory. */
export const MAX_COMMITS = 100_000;
export const MAX_PACK_OBJECTS = 200_000;
const READ_BATCH = 500;

export interface CommitNode {
  tree: string;
  parents: string[];
}

export type CommitGraph = ReadonlyMap<string, CommitNode>;

/** The header lines git needs, without decoding the message. */
function commitLinks(body: Buffer): CommitNode {
  const end = body.indexOf('\n\n');
  const lines = body.toString('latin1', 0, end === -1 ? body.length : end).split('\n');
  const tree = lines.find((l) => l.startsWith('tree '))?.slice(5);
  if (!tree) throw new Error('malformed commit');
  return { tree, parents: lines.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7)) };
}

export async function loadCommitGraph(repo: GitRepo): Promise<CommitGraph> {
  const graph = new Map<string, CommitNode>();
  for await (const { oid, body } of repo.commits()) {
    if (graph.size >= MAX_COMMITS) throw new FetchError(`this repo has more than ${MAX_COMMITS} commits`);
    graph.set(oid, commitLinks(body));
  }
  return graph;
}

/** Every commit reachable from `starts` (those in the graph), stopping at any in `stop`. */
export function ancestors(graph: CommitGraph, starts: Iterable<string>, stop: ReadonlySet<string> = new Set()) {
  const seen = new Set<string>();
  const queue = [...starts].filter((oid) => graph.has(oid) && !stop.has(oid));
  for (const oid of queue) seen.add(oid);
  while (queue.length) {
    for (const parent of graph.get(queue.pop()!)!.parents) {
      if (graph.has(parent) && !seen.has(parent) && !stop.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return seen;
}

/** The haves that are commits of this repo, in the order the client sent them. */
export function commonCommits(graph: CommitGraph, haves: Iterable<string>): string[] {
  return [...new Set(haves)].filter((oid) => graph.has(oid));
}

/**
 * Checks each want is a commit reachable from the head. Wants of an older commit are fine (the head can move
 * between a ref listing and the fetch); anything else is refused as git refuses an unadvertised object.
 */
export function checkWants(graph: CommitGraph, head: string | null, wants: readonly string[]): void {
  if (wants.length === 0) throw new FetchError('no wants');
  const reachable = head ? ancestors(graph, [head]) : new Set<string>();
  for (const want of wants) {
    if (!reachable.has(want)) throw new FetchError(`upload-pack: not our ref ${want}`);
  }
}

export interface PackObject {
  oid: string;
  type: GitObjectType;
}

/**
 * The objects to send for `wants`, given commits the client has. Everything reachable from a common commit
 * counts as had; trees are only compared at the edge (the common parents of sent commits), as git does, so an
 * old blob that comes back may be sent again, which costs bytes and nothing else.
 */
export async function objectsToSend(
  repo: GitRepo,
  graph: CommitGraph,
  wants: readonly string[],
  common: readonly string[],
): Promise<PackObject[]> {
  const had = ancestors(graph, common);
  const commits = ancestors(graph, wants, had);
  const edge = new Set<string>();
  for (const oid of commits) {
    for (const parent of graph.get(oid)!.parents) if (had.has(parent)) edge.add(graph.get(parent)!.tree);
  }

  const excluded = new Set<string>();
  await walkTrees(repo, [...edge], excluded, () => {});

  const out: PackObject[] = [];
  const add = (object: PackObject) => {
    if (out.length >= MAX_PACK_OBJECTS) throw new FetchError(`more than ${MAX_PACK_OBJECTS} objects to send`);
    out.push(object);
  };
  for (const oid of commits) add({ oid, type: 'commit' });
  const roots = [...new Set([...commits].map((oid) => graph.get(oid)!.tree))].filter((t) => !excluded.has(t));
  await walkTrees(repo, roots, excluded, add);
  return out;
}

/**
 * Walks trees breadth first from `roots`, skipping anything in `seen` and adding to it all it visits.
 * `found` hears of each tree and blob the first time it is reached.
 */
async function walkTrees(
  repo: GitRepo,
  roots: readonly string[],
  seen: Set<string>,
  found: (object: PackObject) => void,
): Promise<void> {
  let level = roots.filter((oid) => !seen.has(oid));
  for (const oid of level) seen.add(oid);
  while (level.length) {
    const next: string[] = [];
    for (let at = 0; at < level.length; at += READ_BATCH) {
      const batch = level.slice(at, at + READ_BATCH);
      const trees = await repo.read(batch);
      for (const oid of batch) {
        const tree = trees.get(oid);
        if (!tree || tree.type !== 'tree') throw new Error(`missing tree ${oid}`);
        found({ oid, type: 'tree' });
        for (const entry of parseTree(tree.body)) {
          if (seen.has(entry.oid)) continue;
          seen.add(entry.oid);
          if (entry.isTree) next.push(entry.oid);
          else found({ oid: entry.oid, type: 'blob' });
        }
      }
    }
    level = next;
  }
}

/** The objects' bodies, read a batch at a time, in the order given. */
export async function* readObjects(
  repo: GitRepo,
  objects: readonly PackObject[],
  batchSize = 64,
): AsyncGenerator<{ type: GitObjectType; body: Buffer }> {
  for (let at = 0; at < objects.length; at += batchSize) {
    const batch = objects.slice(at, at + batchSize);
    const found = await repo.read(batch.map((o) => o.oid));
    for (const { oid, type } of batch) {
      const object = found.get(oid);
      if (!object || object.type !== type) throw new Error(`missing ${type} ${oid}`);
      yield object;
    }
  }
}
