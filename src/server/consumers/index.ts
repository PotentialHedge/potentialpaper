import { linksConsumer } from '../page-links';
import { membersConsumer } from '../page-members';
import { reviewsConsumer } from '../review-projection';
import { recomputeDueScopes, scopeStatsConsumer } from '../scope-stats';
import { searchConsumer } from '../search-index';
import type { Consumer } from './types';
import type { WorkerTask } from './worker';

export type { Consumer, ConsumerContext } from './types';

/**
 * Every consumer the `worker` service runs, in no particular order (each has its own cursor): the search index
 * (`search-index.ts`), the review projection (`review-projection.ts`), which fills the tables the Submissions
 * panel reads, the link index (`page-links.ts`, "what links here"), and membership of the pages above the paper
 * (`page-members.ts`), and score statistics of those pages (`scope-stats.ts`), whose consumer only marks scopes; the
 * reviews and members consumers mark them too, and `WORKER_TASKS` recomputes the marked ones.
 */
export const CONSUMERS: readonly Consumer[] = [
  searchConsumer,
  reviewsConsumer,
  linksConsumer,
  membersConsumer,
  scopeStatsConsumer,
];

/** What the worker does after each pass of the consumers. */
export const WORKER_TASKS: readonly WorkerTask[] = [
  {
    name: 'scope-stats',
    run: async (database) => {
      const { scopes, nextInMs } = await recomputeDueScopes({ database });
      return { done: scopes, nextInMs };
    },
  },
];

export function findConsumer(name: string): Consumer | undefined {
  return CONSUMERS.find((consumer) => consumer.name === name);
}
