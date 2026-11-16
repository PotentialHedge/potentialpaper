import { searchConsumer } from '../search-index';
import type { Consumer } from './types';

export type { Consumer, ConsumerContext } from './types';

/**
 * Every consumer the `worker` service runs, in no particular order (each has its own cursor): the search index
 * (`search-index.ts`). The review projection (Phase 5 of `handoffs/data-model.md`) comes next.
 */
export const CONSUMERS: readonly Consumer[] = [searchConsumer];

export function findConsumer(name: string): Consumer | undefined {
  return CONSUMERS.find((consumer) => consumer.name === name);
}
