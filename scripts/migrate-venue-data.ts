import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { getDb, getPool, type Database } from '@/db';
import { pageRefs, pages } from '@/db/schema';
import type { SourceForms } from '@/lib/review-files';
import { venuePlace } from '@/lib/venues';
import { commitPage, SYSTEM_ACTOR } from '@/server/pages/commit';
import { oldSubmissionVenues, planVenueData, type VenueDataContext } from '@/server/pages/layout-migration';
import { rebuildAllPages } from '@/server/pages/projections';
import { readCommit, readFiles, readText } from '@/server/pages/repo';
import { syncVenuePages } from '@/server/venue-pages';

const USAGE = `Keeps each venue's name and forms once, on its page (layout 7, src/server/pages/rules.ts): a system commit per
page that needs one. First the venue pages of every venue a paper's reviews name are made if missing, and each gains a
forms.json with its sources' forms, as the newest paper had them. Then each paper's submission.json keeps only its
venue's id (submission/2), the forms.json beside it goes, and each imported version entry names its venue's page in
place of its name. Then every page's projection is rebuilt. Safe to run again: a page already moved is skipped.

  npm run pages:migrate-venue-data [-- --dry-run]

Afterwards, purge the edge cache (scripts/purge-edge-cache.sh), as for a deploy.`;

interface Ref {
  pageId: string;
  head: string;
  kind: string;
  key: string;
}

async function refsOf(db: Database): Promise<Ref[]> {
  const rows = await db
    .select({ pageId: pageRefs.pageId, head: pageRefs.head, kind: pages.kind, key: pages.key })
    .from(pageRefs)
    .innerJoin(pages, eq(pages.id, pageRefs.pageId));
  return rows.map((row) => ({ ...row, head: row.head.toString('hex') }));
}

async function filesOf(db: Database, ref: Ref): Promise<{ files: Map<string, string>; at: Date }> {
  const commit = await readCommit(db, ref.pageId, ref.head);
  const files = new Map<string, string>();
  for (const [path, blob] of await readFiles(db, ref.pageId, commit.tree)) {
    files.set(path, (await readText(db, ref.pageId, blob)) ?? '');
  }
  return { files, at: commit.at };
}

async function main() {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const dryRun = values['dry-run'] === true;
  const db = getDb();

  // Each source's newest forms and its name, from the papers' submissions.
  const forms = new Map<string, SourceForms & { at: Date }>();
  const names = new Map<string, string>();
  for (const ref of (await refsOf(db)).filter((r) => r.kind === 'paper')) {
    const { files, at } = await filesOf(db, ref);
    for (const { source, name, forms: found } of oldSubmissionVenues(files).values()) {
      if (name && !names.has(source)) names.set(source, name);
      const held = forms.get(source);
      if (found && (!held || held.at < at)) forms.set(source, { ...found, at });
    }
  }
  console.log(`${names.size} venues named by papers' reviews`);
  if (!dryRun && names.size > 0) {
    const made = await syncVenuePages({ venues: [...names].map(([id, name]) => ({ id, name })), database: db });
    console.log(
      `venue pages written: ${made.written.join(', ') || 'none'}; no page: ${made.skipped.join(', ') || 'none'}`,
    );
  }

  const venuePages = new Set(
    (await db.select({ key: pages.key }).from(pages).where(eq(pages.kind, 'venue'))).map((row) => row.key),
  );
  const context: VenueDataContext = {
    forms: new Map(
      [...forms].map(([source, found]) => [source, { forms: found.forms, url: found.url, license: found.license }]),
    ),
    pageOf: (source) => {
      const key = venuePlace(source)?.edition.key;
      return key && venuePages.has(key) ? key : null;
    },
  };

  // Venue pages first, so that a paper's versions name pages whose names and forms are there.
  const order = (kind: string) => (kind === 'venue' ? 0 : kind === 'paper' ? 2 : 1);
  const refs = (await refsOf(db)).sort((a, b) => order(a.kind) - order(b.kind));
  let moved = 0;
  let failed = 0;
  for (const [index, ref] of refs.entries()) {
    const { files } = await filesOf(db, ref);
    const changes = planVenueData({ kind: ref.kind as never }, files, context);
    if (changes.length === 0) continue;
    if (dryRun) {
      console.log(
        `${ref.kind} ${ref.key}: ${changes.map((c) => `${c.content === null ? '-' : ''}${c.path}`).join(' ')}`,
      );
      moved += 1;
      continue;
    }
    try {
      const summary =
        ref.kind === 'venue'
          ? "Keep the venue's forms on its page"
          : ref.kind === 'paper'
            ? 'Name each venue by its page, which keeps its name and forms'
            : 'Layout 7';
      await commitPage(ref.pageId, ref.head, SYSTEM_ACTOR, changes, summary, { migration: true, database: db });
      moved += 1;
    } catch (err) {
      failed += 1;
      const details = (err as { details?: unknown }).details;
      console.error(`${ref.kind} ${ref.key}: ${(err as Error).message}`, details ? JSON.stringify(details) : '');
    }
    if ((index + 1) % 1000 === 0) console.log(`${index + 1} of ${refs.length} pages looked at`);
  }
  console.log(`${dryRun ? 'would move' : 'moved'} ${moved} of ${refs.length} pages; ${failed} failed`);
  if (!dryRun) {
    const rebuilt = await rebuildAllPages(db);
    console.log(`rebuilt ${rebuilt.pages} pages' projections`);
  }
  await getPool().end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
