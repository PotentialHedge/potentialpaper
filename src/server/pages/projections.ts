import { eq, notInArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { authorClaims, commitIdentities, pageCurrent, pageRefs, pageRevisions } from '@/db/schema';
import { KINDS, pageName } from '@/lib/kinds';
import { AUTHOR_PLUGINS_PATH, type AuthorPanel, parseAuthorPlugins } from '@/lib/plugins/author-plugins';
import { pageDemoSources } from '../demos/attach';
import { readLinks, readPagePdf, readThumbnail, readVersions } from './content';
import { type Commit, SYSTEM_AUTHOR_ID } from './git-objects';
import { mustPage, type PageRow } from './kinds';
import { demoRefs } from './markdown';
import { changedFiles, readCommit, readFiles, readHead, readText, toBytes, type Reader } from './repo';
import { partSource, readSections, renderPart } from './sections';

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

/** A paper's `author/plugins.json`, if it has one that parses. */
async function readAuthorPlugins(
  db: Reader,
  page: PageRow,
  files: ReadonlyMap<string, string>,
): Promise<AuthorPanel[] | null> {
  if (page.kind !== 'paper' || !files.has(AUTHOR_PLUGINS_PATH)) return null;
  const parsed = parseAuthorPlugins((await readText(db, page.id, files.get(AUTHOR_PLUGINS_PATH))) ?? '');
  return 'panels' in parsed && parsed.panels.length > 0 ? parsed.panels : null;
}

/** Makes `page_current` say what the commit at the head says. */
export async function writeCurrent(tx: Writer, pageId: string, head: string, commit: Commit): Promise<void> {
  const files = await readFiles(tx, pageId, commit.tree);
  const pdf = await readPagePdf(tx, pageId, files);
  const thumbnail = await readThumbnail(tx, pageId, files);
  const links = await readLinks(tx, pageId, files);
  const versions = await readVersions(tx, pageId, files);
  // The owners' part (a paper's `author/`, a venue's `organizers/`, …) goes in the `author_*` columns.
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
  const row = {
    head: toBytes(head),
    authorMarkdown: partSource(author),
    communityMarkdown: partSource(community),
    authorHtml: renderPart(author, ownersPart ?? 'author', demos),
    communityHtml: renderPart(community, 'community', demos),
    pdf,
    thumbnail,
    links: links.length > 0 ? links : null,
    versions: versions.length > 0 ? versions : null,
    authorPlugins: await readAuthorPlugins(tx, page, files),
    ...(await readKindFile(tx, page, files)),
    updatedAt: commit.at,
  };
  await tx
    .insert(pageCurrent)
    .values({ pageId, ...row })
    .onConflictDoUpdate({ target: pageCurrent.pageId, set: row });
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
  const refs = await database.select({ pageId: pageRefs.pageId }).from(pageRefs);
  const ids = refs.map((ref) => ref.pageId);
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
