import 'dotenv/config';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts, pageRefs, paperIdentifiers } from '@/db/schema';
import { demoBlockMarkdown } from '@/lib/demos';
import { commitPage, type FileChange } from '@/server/pages/commit';
import { refreshPaperPages } from '@/server/pages/refresh';
import { readCommit, readFiles, readText } from '@/server/pages/repo';
import { COMMUNITY_PAGE_PATH, THUMBNAIL_PATH } from '@/server/pages/rules';

/**
 * One-off, for pages from before demos were Markdown blocks and before the picture was the paper's card:
 * each `community/demos.jsonl` becomes a "Demos" section at the end of the community page, and
 * `author/thumbnail.json` moves to `thumbnail.json`. Safe to run again: a page without either is skipped.
 *
 *   npx tsx scripts/move-demos-into-markdown.ts --as <admin handle>
 */

const OLD_DEMOS = 'community/demos.jsonl';
const OLD_THUMBNAIL = 'author/thumbnail.json';

async function main() {
  const { values } = parseArgs({ options: { as: { type: 'string' } } });
  if (!values.as) throw new Error('--as <admin handle>');
  const db = getDb();
  const [admin] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.handle, values.as));
  if (!admin) throw new Error(`no account with the handle ${values.as}`);
  const actor = { kind: 'account' as const, accountId: admin.id, isAdmin: true };

  for (const { paperId } of await db.select({ paperId: pageRefs.paperId }).from(pageRefs)) {
    const [ref] = await db.select({ head: pageRefs.head }).from(pageRefs).where(eq(pageRefs.paperId, paperId));
    const head = ref.head.toString('hex');
    const files = await readFiles(db, paperId, (await readCommit(db, paperId, head)).tree);
    const demos = await readText(db, paperId, files.get(OLD_DEMOS));
    const thumbnail = await readText(db, paperId, files.get(OLD_THUMBNAIL));
    if (demos === null && thumbnail === null) continue;

    const changes: FileChange[] = [];
    if (demos !== null) {
      const blocks = demos
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { id: string; title: string; description?: string })
        .map((demo) => demoBlockMarkdown(demo));
      const community = (await readText(db, paperId, files.get(COMMUNITY_PAGE_PATH))) ?? '';
      const lead = community.trim() === '' ? '' : `${community.replace(/\s+$/, '')}\n\n`;
      changes.push({ path: COMMUNITY_PAGE_PATH, content: `${lead}## Demos\n\n${blocks.join('\n')}` });
      changes.push({ path: OLD_DEMOS, content: null });
    }
    if (thumbnail !== null) {
      changes.push({ path: THUMBNAIL_PATH, content: thumbnail });
      changes.push({ path: OLD_THUMBNAIL, content: null });
    }
    const result = await commitPage(
      paperId,
      head,
      actor,
      changes,
      'Move demos into the page, and the picture to the card',
    );
    const identifiers = await db
      .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
      .from(paperIdentifiers)
      .where(eq(paperIdentifiers.paperId, paperId));
    await refreshPaperPages(identifiers);
    console.log(paperId, result.status, changes.map((c) => c.path).join(', '));
  }
  await getPool().end();
}

main().catch((err) => {
  console.error(err.message ?? err, err.details ? JSON.stringify(err.details) : '');
  process.exit(1);
});
