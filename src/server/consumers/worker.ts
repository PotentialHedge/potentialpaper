import { Client } from 'pg';
import { getDb, type Database } from '@/db';
import { runConsumer, type RunReport } from './run';
import { type Consumer, EVENTS_CHANNEL } from './types';

/**
 * The `worker` service (`npm run consumers:work`): runs every consumer until it has caught up, then sleeps until
 * a commit says something changed (`NOTIFY page_events`, sent by `recordCommit` and delivered when its
 * transaction commits) or `pollMs` passes, whichever is first. The poll covers a lost notification, the
 * listening connection being down, and events held back behind a long transaction (`run.ts`).
 */

export const POLL_MS = 15_000;

export interface WorkerOptions {
  consumers: readonly Consumer[];
  database?: Database;
  /** Where to `LISTEN`; without one, the worker only polls. */
  listenUrl?: string;
  pollMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Called after every pass, for tests. */
  onPass?: (reports: RunReport[]) => void;
}

/** A wake-up that can be waited for, and that remembers a ring that came while nobody was waiting. */
function doorbell() {
  let rung = false;
  let wake: (() => void) | null = null;
  return {
    ring() {
      rung = true;
      wake?.();
    },
    wait(ms: number, signal?: AbortSignal): Promise<void> {
      if (rung || signal?.aborted) {
        rung = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          wake = null;
          rung = false;
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal?.addEventListener('abort', done);
        wake = done;
      });
    },
  };
}

/** Keeps a `LISTEN` connection open, reconnecting after a failure; rings the bell on every notification. */
function listen(url: string, ring: () => void, log: (line: string) => void, signal?: AbortSignal): () => Promise<void> {
  let client: Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;

  const connect = async () => {
    if (stopped) return;
    const next = new Client({ connectionString: url });
    const lost = (err?: unknown) => {
      if (client !== next) return;
      client = null;
      next.end().catch(() => {});
      if (stopped) return;
      if (err) log(`worker: listening connection lost (${err instanceof Error ? err.message : String(err)})`);
      // A notification may have been missed while it was down.
      ring();
      retry = setTimeout(() => void connect(), 5_000);
    };
    next.on('notification', () => ring());
    next.on('error', lost);
    next.on('end', () => lost(new Error('closed')));
    client = next;
    try {
      await next.connect();
      await next.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (err) {
      lost(err);
    }
  };
  void connect();

  const stop = async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    const current = client;
    client = null;
    await current?.end().catch(() => {});
  };
  signal?.addEventListener('abort', () => void stop());
  return stop;
}

/** Runs until `signal` aborts. */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const { consumers, signal, pollMs = POLL_MS, log = () => {} } = options;
  const database = options.database ?? getDb();
  const bell = doorbell();
  const stopListening = options.listenUrl ? listen(options.listenUrl, () => bell.ring(), log, signal) : null;

  try {
    while (!signal?.aborted) {
      const reports: RunReport[] = [];
      for (const consumer of consumers) {
        try {
          const report = await runConsumer(consumer, { database });
          reports.push(report);
          if (report.events > 0 || report.status === 'failed') {
            log(
              `${report.name}: ${report.events} events, ${report.pages} pages, ${report.status}` +
                (report.error ? `\n${report.error}` : ''),
            );
          }
        } catch (err) {
          // The database restarting, say: try again on the next pass.
          log(`${consumer.name}: pass failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      }
      options.onPass?.(reports);
      await bell.wait(pollMs, signal);
    }
  } finally {
    await stopListening?.();
  }
}
