import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts, user } from '@/db/schema';
import { parsePaperId, PAPER_SCHEMES, type PaperScheme } from '@/lib/paper-ids';
import { isAdminEmail } from '@/server/auth';
import { type Actor, commitPage, type FileChange, revertCommit, SYSTEM_ACTOR } from '@/server/pages/commit';
import { readHead } from '@/server/pages/repo';
import { findPaper } from '@/server/papers';

const USAGE = `Commit to a page's git repo through commitPage, until the editor exists.

  npm run pages:edit -- arxiv:1706.03762 --bot --write community/10-summary.md=./note.md --summary "..."
  npm run pages:edit -- arxiv:1706.03762 --as some-handle --delete community/20-old.md --summary "..."
  npm run pages:edit -- arxiv:1706.03762 --bot --revert <commit id>
  npm run pages:edit -- arxiv:1706.03762 --system

Who: --bot (the labeled site bot, made if missing), --as <handle>, or --system (metadata only).
--system with no change starts the repo with its metadata snapshot.
--base <commit id> says which commit the edit started from; the default is the head.`;

const BOT_HANDLE = 'potentialpaper-bot';

async function botActor(): Promise<Actor> {
  await getDb()
    .insert(accounts)
    .values({ handle: BOT_HANDLE, isBot: true, verifiedAt: sql`clock_timestamp()` })
    .onConflictDoNothing();
  const [bot] = await getDb().select().from(accounts).where(eq(accounts.handle, BOT_HANDLE));
  if (!bot.isBot) throw new Error(`the handle ${BOT_HANDLE} belongs to a person`);
  return { kind: 'account', accountId: bot.id, isAdmin: false };
}

async function handleActor(handle: string): Promise<Actor> {
  const [row] = await getDb()
    .select({ id: accounts.id, email: user.email })
    .from(accounts)
    .leftJoin(user, eq(user.id, accounts.userId))
    .where(eq(accounts.handle, handle.toLowerCase()));
  if (!row) throw new Error(`no account with the handle ${handle}`);
  return { kind: 'account', accountId: row.id, isAdmin: row.email ? isAdminEmail(row.email) : false };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      as: { type: 'string' },
      bot: { type: 'boolean' },
      system: { type: 'boolean' },
      write: { type: 'string', multiple: true, default: [] },
      delete: { type: 'string', multiple: true, default: [] },
      summary: { type: 'string' },
      base: { type: 'string' },
      revert: { type: 'string' },
    },
  });
  const [schemeText, ...rest] = (positionals[0] ?? '').split(':');
  const scheme = PAPER_SCHEMES.find((s): s is PaperScheme => s === schemeText);
  const id = scheme && parsePaperId(scheme, rest.join(':'));
  if (!id || [values.as, values.bot, values.system].filter(Boolean).length !== 1) {
    console.error(USAGE);
    process.exit(2);
  }
  const found = await findPaper(id);
  if (!found) throw new Error(`no paper ${positionals[0]} in this database`);

  const actor = values.system ? SYSTEM_ACTOR : values.bot ? await botActor() : await handleActor(values.as!);
  const paperId = found.paper.id;
  const result = values.revert
    ? await revertCommit(paperId, values.revert, actor, values.summary)
    : await commitPage(
        paperId,
        values.base ?? (await readHead(getDb(), paperId)),
        actor,
        [
          ...values.write.map((spec): FileChange => {
            const at = spec.indexOf('=');
            if (at < 1) throw new Error(`--write wants path=file, not ${spec}`);
            return { path: spec.slice(0, at), content: readFileSync(spec.slice(at + 1), 'utf8') };
          }),
          ...values.delete.map((path): FileChange => ({ path, content: null })),
        ],
        values.summary ?? 'Scripted edit',
      );
  console.log(JSON.stringify(result));
  await getPool().end();
}

main().catch((err) => {
  console.error(err.message ?? err, err.details ? JSON.stringify(err.details, null, 2) : '');
  process.exit(1);
});
