import { linksConsumer } from '../page-links';
import { membersConsumer } from '../page-members';
import { reviewsConsumer } from '../review-projection';
import { searchConsumer } from '../search-index';
import type { Consumer } from './types';

export type { Consumer, ConsumerContext } from './types';

/**
 * Every consumer the `worker` service runs, in no particular order (each has its own cursor): the search index
 * (`search-index.ts`), the review projection (`review-projection.ts`), which fills the tables the Submissions
 * panel reads, the link index (`page-links.ts`, "what links here"), and membership of the pages above the paper
 * (`page-members.ts`).
 */
export const CONSUMERS: readonly Consumer[] = [searchConsumer, reviewsConsumer, linksConsumer, membersConsumer];

export function findConsumer(name: string): Consumer | undefined {
  return CONSUMERS.find((consumer) => consumer.name === name);
}
