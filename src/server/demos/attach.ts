import { getDb, type Database } from '@/db';
import { encodeDemosFile, MAX_DEMO_DESCRIPTION, MAX_DEMO_TITLE, parseDemosFile, type DemoPointer } from '@/lib/demos';
import { ApiError } from '../api/errors';
import { commitPage, type Actor, type CommitResult, type CommitOptions } from '../pages/commit';
import { readCommit, readFiles, readHead, readText } from '../pages/repo';
import { DEMOS_PATH } from '../pages/rules';
import { snapshotDemo, type Snapshot } from './snapshot';

/** The page's demos at its head, and the head they were read at. */
async function currentDemos(
  paperId: string,
  database: Database,
): Promise<{ head: string | null; demos: DemoPointer[] }> {
  const head = await readHead(database, paperId);
  if (!head) return { head, demos: [] };
  const commit = await readCommit(database, paperId, head);
  const text = await readText(database, paperId, (await readFiles(database, paperId, commit.tree)).get(DEMOS_PATH));
  return { head, demos: (text && parseDemosFile(text)) || [] };
}

/**
 * Changes the page's demo list, reading it again and retrying once if someone else changed it at the same
 * moment: two people adding a demo both add a line at the end, which `diff` can't merge.
 */
async function changeDemos(
  paperId: string,
  actor: Actor,
  change: (demos: DemoPointer[]) => { demos: DemoPointer[]; summary: string },
  options: CommitOptions,
): Promise<CommitResult> {
  const database = options.database ?? getDb();
  for (let attempt = 0; ; attempt += 1) {
    const { head, demos } = await currentDemos(paperId, database);
    const { demos: next, summary } = change(demos);
    try {
      return await commitPage(
        paperId,
        head,
        actor,
        [{ path: DEMOS_PATH, content: next.length > 0 ? encodeDemosFile(next) : null }],
        summary,
        options,
      );
    } catch (err) {
      if (attempt === 0 && err instanceof ApiError && err.code === 'edit_conflict') continue;
      throw err;
    }
  }
}

export interface AttachInput {
  url: string;
  title: string;
  description?: string;
}

/** Copies the demo's files from GitHub, then adds it to the page's list. */
export async function attachDemo(
  paperId: string,
  actor: Actor,
  input: AttachInput,
  options: CommitOptions = {},
): Promise<{ snapshot: Snapshot; demo: DemoPointer; commit: CommitResult }> {
  const title = input.title.trim().slice(0, MAX_DEMO_TITLE);
  if (!title) throw new ApiError(422, 'validation_error', 'give the demo a title');
  const description = input.description?.trim().slice(0, MAX_DEMO_DESCRIPTION) || undefined;
  const snapshot = await snapshotDemo(input.url, options.database);
  const demo: DemoPointer = {
    id: snapshot.id,
    title,
    ...(description ? { description } : {}),
    source: snapshot.source,
    commit: snapshot.commit,
    root: snapshot.root,
  };
  const commit = await changeDemos(
    paperId,
    actor,
    (demos) => {
      if (demos.some((known) => known.id === demo.id)) {
        throw new ApiError(422, 'validation_error', 'this demo is already on the page');
      }
      return { demos: [...demos, demo], summary: `Add demo "${title}"` };
    },
    options,
  );
  return { snapshot, demo, commit };
}

export async function removeDemo(
  paperId: string,
  actor: Actor,
  id: string,
  options: CommitOptions = {},
): Promise<CommitResult> {
  return changeDemos(
    paperId,
    actor,
    (demos) => {
      const found = demos.find((demo) => demo.id === id);
      if (!found) throw new ApiError(404, 'not_found', 'no such demo on this page');
      return { demos: demos.filter((demo) => demo.id !== id), summary: `Remove demo "${found.title}"` };
    },
    options,
  );
}
