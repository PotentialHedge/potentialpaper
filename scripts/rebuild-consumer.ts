import 'dotenv/config';
import { getDb, getPool } from '@/db';
import { consumerCursors } from '@/db/schema';
import { CONSUMERS, findConsumer } from '@/server/consumers';
import { rebuildConsumer } from '@/server/consumers/run';

const USAGE = `Starts an outbox consumer over (src/server/consumers/): clears what it holds and sets its cursor back to
zero, so the worker replays every event into it.

  npm run consumers:rebuild -- <name>
  npm run consumers:rebuild            # lists the consumers and their cursors`;

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (name === '--help' || name === '-h' || rest.length > 0) {
    console.log(USAGE);
    return;
  }
  if (!name) {
    console.log(USAGE);
    const cursors = new Map((await getDb().select().from(consumerCursors)).map((row) => [row.name, row]));
    console.log(CONSUMERS.length === 0 ? '\nNo consumers yet.' : '');
    for (const consumer of CONSUMERS) {
      const cursor = cursors.get(consumer.name);
      const at = cursor ? `xid ${cursor.lastXid}, event ${cursor.lastEventId}` : 'not started';
      console.log(
        `  ${consumer.name}: ${at}${cursor?.lastError ? ` (failing: ${cursor.lastError.split('\n')[0]})` : ''}`,
      );
    }
    return;
  }
  const consumer = findConsumer(name);
  if (!consumer) {
    console.error(`no consumer named ${name}; there are: ${CONSUMERS.map((c) => c.name).join(', ') || 'none'}`);
    process.exitCode = 1;
    return;
  }
  await rebuildConsumer(consumer);
  console.log(`${name}: cursor reset to zero; the worker replays every event into it.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
