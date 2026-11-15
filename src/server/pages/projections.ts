import { eq, notInArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { authorClaims, commitIdentities, pageCurrent, pageRefs, pageRevisions } from '@/db/schema';
import { pageDemoSources } from '../demos/attach';
import { readLinks, readPagePdf, readThumbnail, readVersions } from './content';
import { type Commit, SYSTEM_AUTHOR_ID } from './git-objects';
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
export async function lockPage(tx: Writer, paperId: string): Promise<void> {
  await tx.execute(sql`set local lock_timeout = '10s'`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_NAMESPACE + paperId}, 0))`);
}

async function blobSize(db: Reader, paperId: string, blob: string | undefined): Promise<number> {
  const text = await readText(db, paperId, blob);
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
  paperId: string,
  seq: number,
  oid: string,
  commit: Commit,
): Promise<{ paths: string[]; bytesDelta: number }> {
  const parent = commit.parent ? await readCommit(tx, paperId, commit.parent) : null;
  const before = parent ? await readFiles(tx, paperId, parent.tree) : new Map<string, string>();
  const changed = changedFiles(before, await readFiles(tx, paperId, commit.tree));
  let bytesDelta = 0;
  for (const file of changed) {
    bytesDelta += (await blobSize(tx, paperId, file.after)) - (await blobSize(tx, paperId, file.before));
  }
  const paths = changed.map((file) => file.path);
  await tx.insert(pageRevisions).values({
    paperId,
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

/** Makes `page_current` say what the commit at the head says. */
export async function writeCurrent(tx: Writer, paperId: string, head: string, commit: Commit): Promise<void> {
  const files = await readFiles(tx, paperId, commit.tree);
  const pdf = await readPagePdf(tx, paperId, files);
  const thumbnail = await readThumbnail(tx, paperId, files);
  const links = await readLinks(tx, paperId, files);
  const versions = await readVersions(tx, paperId, files);
  const author = await readSections(tx, paperId, files, 'author');
  const community = await readSections(tx, paperId, files, 'community');
  const markdown = [...author, ...community].filter((s) => s.name.format === 'markdown');
  const demos = await pageDemoSources(
    tx,
    paperId,
    head,
    files,
    markdown.flatMap((s) => demoRefs(s.text)),
  );
  const row = {
    head: toBytes(head),
    authorMarkdown: partSource(author),
    communityMarkdown: partSource(community),
    authorHtml: renderPart(author, 'author', demos),
    communityHtml: renderPart(community, 'community', demos),
    pdf,
    thumbnail,
    links: links.length > 0 ? links : null,
    versions: versions.length > 0 ? versions : null,
    updatedAt: commit.at,
  };
  await tx
    .insert(pageCurrent)
    .values({ paperId, ...row })
    .onConflictDoUpdate({ target: pageCurrent.paperId, set: row });
}

/** Replaces one page's projection rows with what its objects say, atomically. */
export async function rebuildPage(paperId: string, database: Database = getDb()): Promise<number> {
  return database.transaction(async (tx) => {
    await lockPage(tx, paperId);
    await tx.delete(pageRevisions).where(eq(pageRevisions.paperId, paperId));
    await tx.delete(pageCurrent).where(eq(pageCurrent.paperId, paperId));
    const head = await readHead(tx, paperId);
    if (!head) return 0;

    const chain: { oid: string; commit: Commit }[] = [];
    for (let oid: string | null = head; oid;) {
      const commit: Commit = await readCommit(tx, paperId, oid);
      chain.push({ oid, commit });
      oid = commit.parent;
    }
    chain.reverse();
    for (const [index, { oid, commit }] of chain.entries()) {
      await writeRevision(tx, paperId, index + 1, oid, commit);
    }
    await writeCurrent(tx, paperId, head, chain[chain.length - 1].commit);
    return chain.length;
  });
}

/** Rebuilds every page, and clears rows of any page that no longer has a repo. */
export async function rebuildAllPages(
  database: Database = getDb(),
  onPage?: (paperId: string, commits: number) => void,
): Promise<{ pages: number; commits: number }> {
  const refs = await database.select({ paperId: pageRefs.paperId }).from(pageRefs);
  const ids = refs.map((ref) => ref.paperId);
  const orphan = <T extends typeof pageRevisions | typeof pageCurrent>(table: T) =>
    ids.length > 0 ? notInArray(table.paperId, ids) : sql`true`;
  await database.delete(pageRevisions).where(orphan(pageRevisions));
  await database.delete(pageCurrent).where(orphan(pageCurrent));
  let commits = 0;
  for (const paperId of ids) {
    const count = await rebuildPage(paperId, database);
    commits += count;
    onPage?.(paperId, count);
  }
  return { pages: ids.length, commits };
}
