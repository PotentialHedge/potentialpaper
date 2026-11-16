import 'dotenv/config';
import { getPool } from '@/db';
import { CONSUMERS, WORKER_TASKS } from '@/server/consumers';
import { runWorker } from '@/server/consumers/worker';

/**
 * The `worker` service: keeps every outbox consumer (`src/server/consumers/`) up with `page_events`, woken by
 * commits and polling as a fallback. Stops cleanly on SIGINT/SIGTERM.
 */
async function main() {
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
  const names = CONSUMERS.map((consumer) => consumer.name).join(', ') || 'none yet';
  console.log(`worker: consumers ${names}`);
  await runWorker({
    consumers: CONSUMERS,
    tasks: WORKER_TASKS,
    listenUrl: process.env.DATABASE_URL,
    signal: controller.signal,
    log: (line) => console.log(line),
  });
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
