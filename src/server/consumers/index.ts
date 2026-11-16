import { reviewsConsumer } from '../review-projection';
import { searchConsumer } from '../search-index';
import type { Consumer } from './types';

export type { Consumer, ConsumerContext } from './types';

/**
 * Every consumer the `worker` service runs, in no particular order (each has its own cursor): the search index
 * (`search-index.ts`) and the review projection (`review-projection.ts`), which fills the tables the Submissions
 * panel reads.
 */
export const CONSUMERS: readonly Consumer[] = [searchConsumer, reviewsConsumer];

export function findConsumer(name: string): Consumer | undefined {
  return CONSUMERS.find((consumer) => consumer.name === name);
}
