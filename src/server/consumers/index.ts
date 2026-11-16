import type { Consumer } from './types';

export type { Consumer, ConsumerContext } from './types';

/**
 * Every consumer the `worker` service runs, in no particular order (each has its own cursor). Empty until the
 * search index (Phase 4 of `handoffs/data-model.md`) and the review projection (Phase 5) add theirs.
 */
export const CONSUMERS: readonly Consumer[] = [];

export function findConsumer(name: string): Consumer | undefined {
  return CONSUMERS.find((consumer) => consumer.name === name);
}
