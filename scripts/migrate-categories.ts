import 'dotenv/config';
import { parseArgs } from 'node:util';
import { getDb, getPool } from '@/db';
import { pageRefs } from '@/db/schema';
import { KINDS } from '@/lib/kinds';
import { LINKS_FILE } from '@/lib/labeled-links';
import { commitPage, type FileChange, SYSTEM_ACTOR } from '@/server/pages/commit';
import { readCommit, readFiles, readText } from '@/server/pages/repo';
import { METADATA_PATH } from '@/server/pages/rules';

const USAGE = `Rewrites every page repo from topics to categories (migration 0055): a topic page's metadata and
topic.json become a category's, and every links.jsonl line that puts a page in a topic (in-topic, introduces-topic)
or names one (topic:<slug>) says category instead. A system commit per page that needs one; safe to run again.

  npm run pages:migrate-categories [-- --dry-run]

Run it after the database migration. Afterwards, purge the edge cache (scripts/purge-edge-cache.sh).`;

const OLD_KIND_FILE = 'topic.json';

/** A `links.jsonl` with its topic labels and targets said as categories, or `null` if nothing changes. */
function rewriteLinks(text: string): string | null {
  let changed = false;
  const lines = text.split('\n').map((line) => {
    if (!line.trim()) return line;
    try {
      const link = JSON.parse(line) as { label?: string; to?: string };
      if (link.label === 'in-topic' || link.label === 'introduces-topic') link.label = 'in-category';
      if (typeof link.to === 'string' && link.to.startsWith('topic:')) link.to = `category:${link.to.slice(6)}`;
      const out = JSON.stringify(link);
      if (out !== line) changed = true;
      return out;
    } catch {
      return line;
    }
  });
  return changed ? lines.join('\n') : null;
}

function plan(files: Map<string, string>): FileChange[] {
  const changes: FileChange[] = [];
  const metadata = files.get(METADATA_PATH);
  if (metadata) {
    try {
      const value = JSON.parse(metadata) as { kind?: string };
      if (value.kind === 'topic') {
        value.kind = 'category';
        changes.push({ path: METADATA_PATH, content: `${JSON.stringify(value, null, 2)}\n` });
      }
    } catch {
      // Not ours to fix here.
    }
  }
  const old = files.get(OLD_KIND_FILE);
  if (old !== undefined) {
    let name = '';
    try {
      name = String((JSON.parse(old) as { name?: unknown }).name ?? '');
    } catch {
      // Left without a name: the commit's checks say so.
    }
    changes.push({ path: OLD_KIND_FILE, content: null });
    changes.push({ path: KINDS.category.kindFile!, content: `${JSON.stringify({ name }, null, 2)}\n` });
  }
  for (const [path, text] of files) {
    if (path !== LINKS_FILE && !path.endsWith(`/${LINKS_FILE}`)) continue;
    const rewritten = rewriteLinks(text);
    if (rewritten !== null) changes.push({ path, content: rewritten });
  }
  return changes;
}

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const db = getDb();
  const refs = await db.select({ pageId: pageRefs.pageId, head: pageRefs.head }).from(pageRefs);
  let moved = 0;
  let failed = 0;
  for (const { pageId, head } of refs) {
    const oid = head.toString('hex');
    const files = new Map<string, string>();
    for (const [path, blob] of await readFiles(db, pageId, (await readCommit(db, pageId, oid)).tree)) {
      if (path === METADATA_PATH || path === OLD_KIND_FILE || path.endsWith(LINKS_FILE)) {
        files.set(path, (await readText(db, pageId, blob)) ?? '');
      }
    }
    const changes = plan(files);
    if (changes.length === 0) continue;
    if (values['dry-run']) {
      console.log(`${pageId}: ${changes.map((c) => `${c.content === null ? '-' : '+'}${c.path}`).join(' ')}`);
      moved += 1;
      continue;
    }
    try {
      await commitPage(pageId, oid, SYSTEM_ACTOR, changes, 'Topics are categories now', { migration: true });
      moved += 1;
    } catch (err) {
      failed += 1;
      const details = (err as { details?: unknown }).details;
      console.error(`${pageId}: ${(err as Error).message}`, details ? JSON.stringify(details) : '');
    }
  }
  console.log(`${values['dry-run'] ? 'would rewrite' : 'rewrote'} ${moved} of ${refs.length} pages; ${failed} failed`);
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
