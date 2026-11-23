import { eq, notInArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { authorClaims, commitIdentities, pageCurrent, pageRefs, pageRevisions, pages, papers } from '@/db/schema';
import { KINDS, OWNERS_DIR, pageName } from '@/lib/kinds';
import { FACTS_FILE, parseFacts, type PageFacts } from '@/lib/infobox-facts';
import { AUTHOR_PLUGINS_PATH, type AuthorPanel, parseAuthorPlugins } from '@/lib/plugins/author-plugins';
import { pageDemoSources } from '../demos/attach';
import { followAuthors } from './follow-authors';
import { readLinks, readThumbnail, readVersions } from './content';
import { listedVenue, paperRowOf, parsePaperFile } from '@/lib/paper-file';
import { paperPdfOf, type PaperVersion } from '@/lib/versions';
import { type Commit, SYSTEM_AUTHOR_ID } from './git-objects';
import { mustPage, type PageRow } from './kinds';
import { demoRefs } from './markdown';
import { changedFiles, readCommit, readFiles, readHead, readText, toBytes, type Reader } from './repo';
import { partSource, readSections, renderPart } from './sections';
import { resolveVenueNames, writeVenueRows } from './venue-projection';

/**
 * The rows that can be derived from the objects (DESIGN.md §4.5). A commit and a rebuild both come through
 * the functions here, and they read only the objects, `commit_identities` and `lfs_objects` (where the
 * bytes of a PDF or picture are, which never changes), which is why a rebuild gives identical rows.
 */

export type Writer = Reader & Pick<Database, 'insert' | 'update' | 'delete'>;

const LOCK_NAMESPACE = 'page-repo:';

/**
 * One writer per page at a time, until the transaction ends. Waiting here instead of failing at the
 * compare-and-swap means concurrent edits merge rather than retry.
 */
export async function lockPage(tx: Writer, pageId: string): Promise<void> {
  await tx.execute(sql`set local lock_timeout = '10s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAMESPACE + pageId}, 0))`);
}

async function blobSize(db: Reader, pageId: string, blob: string | undefined): Promise<number> {
  const text = await readText(db, pageId, blob);
  return text === null ? 0 : Buffer.byteLength(text);
}

async function accountOf(db: Reader, authorId: string): Promise<string | null> {
  if (authorId === SYSTEM_AUTHOR_ID) return null;
  if (authorId.startsWith('a_')) {
    const [claim] = await db
      .select({ accountId: authorClaims.accountId })
      .from(authorClaims)
      .where(eq(authorClaims.identityId, authorId));
    return claim?.accountId ?? null;
  }
  const [row] = await db
    .select({ accountId: commitIdentities.accountId })
    .from(commitIdentities)
    .where(eq(commitIdentities.id, authorId));
  return row?.accountId ?? null;
}

/** The row for a commit, which has to be on `main` at position `seq`. Returns the paths it changed. */
export async function writeRevision(
  tx: Writer,
  pageId: string,
  seq: number,
  oid: string,
  commit: Commit,
): Promise<{ paths: string[]; bytesDelta: number }> {
  const parent = commit.parent ? await readCommit(tx, pageId, commit.parent) : null;
  const before = parent ? await readFiles(tx, pageId, parent.tree) : new Map<string, string>();
  const changed = changedFiles(before, await readFiles(tx, pageId, commit.tree));
  let bytesDelta = 0;
  for (const file of changed) {
    bytesDelta += (await blobSize(tx, pageId, file.after)) - (await blobSize(tx, pageId, file.before));
  }
  const paths = changed.map((file) => file.path);
  await tx.insert(pageRevisions).values({
    pageId,
    seq,
    oid: toBytes(oid),
    authorId: commit.authorId,
    accountId: await accountOf(tx, commit.authorId),
    kind: commit.kind,
    summary: commit.summary,
    paths,
    bytesDelta,
    evidence: commit.evidence ?? [],
    at: commit.at,
  });
  return { paths, bytesDelta };
}

/** A keyed page's kind file as it parses, and the name it shows; both `null` on a paper's page. */
async function readKindFile(
  db: Reader,
  page: PageRow,
  files: ReadonlyMap<string, string>,
): Promise<{ kindFile: Record<string, unknown> | null; name: string | null }> {
  if (page.kind === 'paper') return { kindFile: null, name: null };
  const { kindFile: path, kindFileSchema } = KINDS[page.kind];
  let kindFile: Record<string, unknown> | null = null;
  try {
    const parsed = kindFileSchema?.safeParse(JSON.parse((await readText(db, page.id, files.get(path))) ?? ''));
    if (parsed?.success) kindFile = parsed.data as Record<string, unknown>;
  } catch {
    // No kind file yet, or one from before its schema: the page shows its key.
  }
  return { kindFile, name: pageName(page.kind, page.key, kindFile) };
}

/** A paper's `owners/plugins.json`, if it has one that parses. */
async function readAuthorPlugins(
  db: Reader,
  page: PageRow,
  files: ReadonlyMap<string, string>,
): Promise<AuthorPanel[] | null> {
  if (page.kind !== 'paper' || !files.has(AUTHOR_PLUGINS_PATH)) return null;
  const parsed = parseAuthorPlugins((await readText(db, page.id, files.get(AUTHOR_PLUGINS_PATH))) ?? '');
  return 'panels' in parsed && parsed.panels.length > 0 ? parsed.panels : null;
}

/** The page's own infobox rows, by part; `null` when it has none, or its kind has none. */
async function readFacts(db: Reader, page: PageRow, files: ReadonlyMap<string, string>): Promise<PageFacts | null> {
  if (!(KINDS[page.kind].fileTypes as readonly string[]).includes('fact')) return null;
  const read = async (part: string) => {
    const blob = files.get(`${part}/${FACTS_FILE}`);
    if (!blob) return [];
    const parsed = parseFacts((await readText(db, page.id, blob)) ?? '', page.kind);
    return 'facts' in parsed ? parsed.facts : [];
  };
  const facts = { owners: await read(KINDS[page.kind].owners?.dir ?? OWNERS_DIR), community: await read('community') };
  return facts.owners.length + facts.community.length > 0 ? facts : null;
}

/**
 * A paper's row says what its `paper.json` says, and where its versions say it went (`listedVenue`). A file that
 * doesn't parse leaves the row as it was: the rules (`check.ts`) let none in, so that is a repo from before them.
 * Claims follow the authors to where their names are now (`followAuthors`).
 */
async function writePaperRow(
  tx: Writer,
  page: PageRow,
  files: ReadonlyMap<string, string>,
  versions: PaperVersion[],
): Promise<void> {
  if (page.kind !== 'paper') return;
  const file = parsePaperFile(await readText(tx, page.id, files.get(KINDS.paper.kindFile)));
  await tx
    .update(papers)
    .set({ ...(file ? paperRowOf(file) : {}), ...listedVenue(versions) })
    .where(eq(papers.id, page.id));
  if (file) await followAuthors(tx, page.id, file.authors);
}

/** Makes `page_current` say what the commit at the head says, and a paper's row what its files say. */
export async function writeCurrent(tx: Writer, pageId: string, head: string, commit: Commit): Promise<void> {
  const files = await readFiles(tx, pageId, commit.tree);
  const thumbnail = await readThumbnail(tx, pageId, files);
  const links = await readLinks(tx, pageId, files);
  // A submission naming a venue page shows the page's name (`venue-projection.ts`).
  const versions = await resolveVenueNames(tx, await readVersions(tx, pageId, files));
  // Every PDF is a version's: the page shows the newest.
  const pdf = paperPdfOf(versions);
  // The owners' part, `owners/`, goes in the `author_*` columns.
  const page = await mustPage(tx, pageId);
  const { owners, community: hasCommunity } = KINDS[page.kind];
  const ownersPart = owners?.dir ?? null;
  const author = ownersPart ? await readSections(tx, pageId, files, ownersPart) : [];
  const community = hasCommunity ? await readSections(tx, pageId, files, 'community') : [];
  const markdown = [...author, ...community].filter((s) => s.name.format === 'markdown');
  const demos = await pageDemoSources(
    tx,
    pageId,
    head,
    files,
    markdown.flatMap((s) => demoRefs(s.text)),
  );
  const kind = await readKindFile(tx, page, files);
  const row = {
    head: toBytes(head),
    authorMarkdown: partSource(author),
    communityMarkdown: partSource(community),
    authorHtml: renderPart(author, ownersPart ?? 'owners', demos),
    communityHtml: renderPart(community, 'community', demos),
    pdf,
    thumbnail,
    links: links.length > 0 ? links : null,
    versions: versions.length > 0 ? versions : null,
    authorPlugins: await readAuthorPlugins(tx, page, files),
    facts: await readFacts(tx, page, files),
    ...kind,
    updatedAt: commit.at,
  };
  await tx
    .insert(pageCurrent)
    .values({ pageId, ...row })
    .onConflictDoUpdate({ target: pageCurrent.pageId, set: row });
  await writePaperRow(tx, page, files, versions);
  // The `venues` rows of the sources a venue page lists are its projection.
  if (page.kind === 'venue') await writeVenueRows(tx, pageId, kind.kindFile, files);
}

/**
 * Writes a page's `page_current` (and a paper's row) again at the head it is at, for what it shows from other pages:
 * the names of the venue pages its versions name (`server/venue-names.ts`). Nothing in its repo changed.
 */
export async function reprojectCurrent(pageId: string, database: Database = getDb()): Promise<boolean> {
  return database.transaction(async (tx) => {
    await lockPage(tx, pageId);
    const head = await readHead(tx, pageId);
    if (!head) return false;
    await writeCurrent(tx, pageId, head, await readCommit(tx, pageId, head));
    return true;
  });
}

/** Replaces one page's projection rows with what its objects say, atomically. */
export async function rebuildPage(pageId: string, database: Database = getDb()): Promise<number> {
  return database.transaction(async (tx) => {
    await lockPage(tx, pageId);
    await tx.delete(pageRevisions).where(eq(pageRevisions.pageId, pageId));
    await tx.delete(pageCurrent).where(eq(pageCurrent.pageId, pageId));
    const head = await readHead(tx, pageId);
    if (!head) return 0;

    const chain: { oid: string; commit: Commit }[] = [];
    for (let oid: string | null = head; oid;) {
      const commit: Commit = await readCommit(tx, pageId, oid);
      chain.push({ oid, commit });
      oid = commit.parent;
    }
    chain.reverse();
    for (const [index, { oid, commit }] of chain.entries()) {
      await writeRevision(tx, pageId, index + 1, oid, commit);
    }
    await writeCurrent(tx, pageId, head, chain[chain.length - 1].commit);
    return chain.length;
  });
}

/** Rebuilds every page, and clears rows of any page that no longer has a repo. */
export async function rebuildAllPages(
  database: Database = getDb(),
  onPage?: (pageId: string, commits: number) => void,
): Promise<{ pages: number; commits: number }> {
  const refs = await database
    .select({ pageId: pageRefs.pageId, kind: pages.kind })
    .from(pageRefs)
    .innerJoin(pages, eq(pages.id, pageRefs.pageId));
  // Venue pages first: a paper shows the names of the venue pages its versions name (`venue-projection.ts`).
  const ids = [...refs.filter((ref) => ref.kind === 'venue'), ...refs.filter((ref) => ref.kind !== 'venue')].map(
    (ref) => ref.pageId,
  );
  const orphan = <T extends typeof pageRevisions | typeof pageCurrent>(table: T) =>
    ids.length > 0 ? notInArray(table.pageId, ids) : sql`true`;
  await database.delete(pageRevisions).where(orphan(pageRevisions));
  await database.delete(pageCurrent).where(orphan(pageCurrent));
  let commits = 0;
  for (const pageId of ids) {
    const count = await rebuildPage(pageId, database);
    commits += count;
    onPage?.(pageId, count);
  }
  return { pages: ids.length, commits };
}
