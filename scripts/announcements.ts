import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { addAnnouncement, allAnnouncements, hideAnnouncement } from '@/server/announcements';

const USAGE = `Messages at the top of the home page, in Markdown. Admins only, on the server.

  npm run announcements                                  # lists them, newest first
  npm run announcements -- add "<markdown>" [--signed-in] # shows one (--signed-in: only to signed-in readers)
  npm run announcements -- hide <id>                     # hides one`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, 'signed-in': { type: 'boolean' } },
  });
  const [command, ...args] = positionals;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!command) {
    const rows = await allAnnouncements();
    if (rows.length === 0) console.log('No announcements.');
    for (const a of rows) {
      const state = a.hiddenAt ? 'hidden' : a.signedInOnly ? 'shown, signed in' : 'shown';
      console.log(`${a.id}  ${a.createdAt.toISOString().slice(0, 10)}  ${state}\n  ${a.body.replace(/\n/g, '\n  ')}`);
    }
    return;
  }
  if (command === 'add' && args.length === 1) {
    const a = await addAnnouncement({ body: args[0], signedInOnly: values['signed-in'] });
    console.log(`Added ${a.id}.`);
    return;
  }
  if (command === 'hide' && args.length === 1) {
    if (!(await hideAnnouncement(args[0]))) throw new Error(`no shown announcement ${args[0]}`);
    console.log('Hidden.');
    return;
  }
  console.log(USAGE);
  process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
