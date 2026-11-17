import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { getPool } from '@/db';
import { formatProblem, setInSettings } from '@/lib/settings';
import { ApiError } from '@/server/api/errors';
import { saveSiteSettings, siteSettingsText } from '@/server/settings';

const USAGE = `The site layer of settings.json (DESIGN.md §10), between the defaults and every user's file. Admins only,
on the server. The file is JSONC; it is checked as a user's is, and nothing is saved if it has errors.

  npm run settings:site                        # prints the site's settings.json
  npm run settings:site -- set <file>          # replaces it with a file
  npm run settings:site -- set -               # ... read from stdin
  npm run settings:site -- put <key> <json>    # sets one key, keeping the rest and its comments
  npm run settings:site -- put <key>           # removes one key`;

async function readInput(path: string): Promise<string> {
  if (path !== '-') return readFile(path, 'utf8');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function save(text: string) {
  try {
    const warnings = await saveSiteSettings(text);
    for (const w of warnings) console.warn(`warning: ${formatProblem(w)}`);
    console.log('Saved the site settings.');
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' } },
  });
  const [command, ...args] = positionals;
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (!command) {
    process.stdout.write(await siteSettingsText());
    return;
  }
  if (command === 'set' && args.length === 1) return save(await readInput(args[0]));
  if (command === 'put' && (args.length === 1 || args.length === 2)) {
    const [key, json] = args;
    let value: unknown;
    if (json !== undefined) {
      try {
        value = JSON.parse(json);
      } catch {
        throw new Error(`not JSON: ${json} (a string needs its quotes: '"text"')`);
      }
    }
    return save(setInSettings(await siteSettingsText(), key, value));
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
