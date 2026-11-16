import type { Database } from '@/db';

/**
 * An outbox consumer (DESIGN.md §4.9): derived data outside `page_current` (search, the review projection,
 * webhooks, feeds) that keeps up with commits by reading `page_events`.
 *
 * `handle` does one job, "bring page `paperId` up to commit `head`": read the page at that commit and replace
 * whatever the consumer holds for the page. It must be idempotent, since an event can be handed over again
 * (after a crash, or when a rebuild starts over), and it is only ever given a page's latest head among the
 * events read together, never every commit in between. Throwing stops the consumer at that page; it tries
 * again on the next pass and nothing after it is read until it passes.
 */
export interface Consumer {
  /** Its row in `consumer_cursors`; renaming it starts it over from the first event. */
  name: string;
  handle(paperId: string, head: string, context: ConsumerContext): Promise<void>;
  /** Clears everything it holds, before `consumers:rebuild` sets its cursor back to zero. */
  reset?(context: ConsumerContext): Promise<void>;
}

export interface ConsumerContext {
  database: Database;
}

/** The channel `recordCommit` notifies on, to wake the worker; the payload is the paper's id. */
export const EVENTS_CHANNEL = 'page_events';
