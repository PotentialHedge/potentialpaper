import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { demoPins, demoSnapshots } from '@/db/schema';
import { DEMOS_DIR, demoRefKey, type DemoRef, type DemoSource } from '@/lib/demos';
import { ApiError } from '../api/errors';
import { pageRepo } from '../git/repo';
import { demoBlockProblems, demoIds, demoRefs } from '../pages/markdown';
import type { Writer } from '../pages/projections';
import { readCommit, readFiles, readHead, readText, toBytes, type Reader } from '../pages/repo';
import {
  demoPath,
  isDemoPath,
  MAX_DEMOS_BYTES,
  MAX_DEMOS_FILES,
  PAGE_PARTS,
  type PagePart,
  type Roles,
  sectionName,
} from '../pages/rules';
import { demoFolders, pageDemoSnapshot } from './repo';
import { snapshotDemo } from './snapshot';

/**
 * Demos live in a page's Markdown, as ```` ```demo <name> ```` blocks (`lib/demos.ts`). This is where the
 * names meet the snapshots they stand for: a snapshot id is one, a GitHub address is pinned to one when the
 * commit that adds it comes in, and `demos/<name>` is the page's own folder. The commit path checks the
 * blocks here, whoever wrote them and however (a web edit, or later a push).
 */

/** Where each named snapshot came from. Snapshots never change, so a rebuild reads the same. */
export async function demoSources(db: Reader, ids: readonly string[]): Promise<Map<string, DemoSource>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: demoSnapshots.id,
      source: demoSnapshots.source,
      commit: demoSnapshots.commit,
      root: demoSnapshots.root,
    })
    .from(demoSnapshots)
    .where(inArray(demoSnapshots.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

/** The snapshots the page's GitHub addresses are pinned to, by address. */
async function pinnedSources(db: Reader, pageId: string, urls: readonly string[]): Promise<Map<string, DemoSource>> {
  if (urls.length === 0) return new Map();
  const rows = await db
    .select({
      url: demoPins.url,
      id: demoSnapshots.id,
      source: demoSnapshots.source,
      commit: demoSnapshots.commit,
      root: demoSnapshots.root,
    })
    .from(demoPins)
    .innerJoin(demoSnapshots, eq(demoSnapshots.id, demoPins.snapshotId))
    .where(and(eq(demoPins.pageId, pageId), inArray(demoPins.url, [...urls])));
  return new Map(rows.map(({ url, ...source }) => [url, source]));
}

/**
 * The source of every demo the page's blocks name, by `demoRefKey`, for rendering the page at `commit`.
 * A page's own folder becomes a snapshot here the first time it is seen.
 */
export async function pageDemoSources(
  tx: Writer,
  pageId: string,
  commit: string,
  files: ReadonlyMap<string, string>,
  refs: readonly DemoRef[],
): Promise<Map<string, DemoSource>> {
  const found = await demoSources(
    tx,
    refs.flatMap((ref) => (ref.kind === 'snapshot' ? [ref.id] : [])),
  );
  const pinned = await pinnedSources(
    tx,
    pageId,
    refs.flatMap((ref) => (ref.kind === 'github' ? [ref.url] : [])),
  );
  for (const [url, source] of pinned) found.set(url, source);
  const folders = demoFolders(files);
  for (const ref of refs) {
    const folder = ref.kind === 'repo' ? folders.get(ref.name) : undefined;
    if (ref.kind !== 'repo' || !folder) continue;
    const source = await pageDemoSnapshot(tx, pageId, commit, ref.name, folder);
    if (source) found.set(demoRefKey(ref), source);
  }
  return found;
}

/** The previews' sources: snapshots by id only, since an address is copied, and a folder read, on commit. */
export async function previewDemoSources(markdown: string, db: Reader = getDb()): Promise<Map<string, DemoSource>> {
  return demoSources(db, demoIds(markdown));
}

function isMarkdownSection(path: string): boolean {
  return PAGE_PARTS.some((part) => sectionName(path, part)?.format === 'markdown');
}

function partOf(path: string): PagePart | undefined {
  return PAGE_PARTS.find((part) => sectionName(path, part));
}

/** At most this many new GitHub addresses in one commit, as each is a download. */
export const MAX_NEW_DEMO_URLS = 5;

function githubUrls(refs: readonly DemoRef[]): string[] {
  return refs.flatMap((ref) => (ref.kind === 'github' ? [ref.url] : []));
}

/**
 * The GitHub addresses these new texts put on the page, that the head's Markdown doesn't have. Read before
 * the commit's lock, to copy them first (`copyDemos`); the commit then checks under the lock that every
 * address new to the page has a copy (`checkDemos`).
 */
export async function newDemoUrls(
  database: Reader,
  pageId: string,
  changes: readonly { path: string; content: string | null }[],
): Promise<string[]> {
  const urls = new Set(
    changes.flatMap(({ path, content }) =>
      content !== null && isMarkdownSection(path) ? githubUrls(demoRefs(content)) : [],
    ),
  );
  if (urls.size === 0) return [];
  const head = await readHead(database, pageId);
  if (head) {
    const files = await readFiles(database, pageId, (await readCommit(database, pageId, head)).tree);
    for (const [path, blob] of files) {
      if (!isMarkdownSection(path)) continue;
      for (const url of githubUrls(demoRefs(await readText(database, pageId, blob)))) urls.delete(url);
    }
  }
  if (urls.size > MAX_NEW_DEMO_URLS) throw tooManyDemoUrls();
  return [...urls];
}

function tooManyDemoUrls(): ApiError {
  return new ApiError(422, 'validation_error', `a commit can add at most ${MAX_NEW_DEMO_URLS} demos from GitHub`);
}

/**
 * Copies the demos at these GitHub addresses, before the commit's transaction, since each is a download that
 * may take a while. Returns the snapshot of each, by address. Called once the commit's other checks passed.
 */
export async function copyDemos(database: Database, urls: Iterable<string>): Promise<Map<string, string>> {
  const snapshots = new Map<string, string>();
  for (const url of urls) {
    if (snapshots.has(url)) continue;
    try {
      snapshots.set(url, (await snapshotDemo(url, database)).id);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      throw new ApiError(err.status, err.code, `the demo at ${url}: ${err.message}`, { ...err.details, url });
    }
  }
  return snapshots;
}

export interface DemoPin {
  url: string;
  snapshotId: string;
}

export interface DemoCheck {
  pageId: string;
  roles: Roles;
  /** The paths the commit writes or deletes. */
  changed: readonly string[];
  headFiles: ReadonlyMap<string, string>;
  /** The tree the commit will have. */
  files: ReadonlyMap<string, string>;
  /** A blob's text, whether it is new in this commit or already stored. */
  text: (blob: string) => Promise<string | null>;
  /** The size of each blob new in this commit. */
  newBlobBytes: ReadonlyMap<string, number>;
  /** A system migration, which writes what it must. */
  migration: boolean;
}

/**
 * The demo rules that need the whole tree: every block in a written section names a demo there is, a
 * folder a block names has an `index.html`, a folder the author section shows is only its authors' to
 * change, and the folders' limits. Returns the GitHub addresses new to the page, which have to be copied
 * (`copyDemos`) and are pinned once the commit has an id (`pinsFor`).
 */
export async function checkDemos(tx: Reader, check: DemoCheck): Promise<string[]> {
  const { changed, headFiles, files, text } = check;
  const touchesDemos = changed.some(isDemoPath);
  if (!touchesDemos && !changed.some(isMarkdownSection)) return [];

  const refsIn = async (tree: ReadonlyMap<string, string>, only?: PagePart) => {
    const found: { path: string; refs: DemoRef[] }[] = [];
    for (const [path, blob] of tree) {
      if (!isMarkdownSection(path) || (only && partOf(path) !== only)) continue;
      found.push({ path, refs: demoRefs(await text(blob)) });
    }
    return found;
  };

  for (const path of changed) {
    const blob = files.get(path);
    if (!blob || !isMarkdownSection(path)) continue;
    const content = (await text(blob)) ?? '';
    const [problem] = demoBlockProblems(content);
    if (problem) throw new ApiError(422, 'validation_error', `${path}: ${problem}`, { path });
    const ids = demoIds(content);
    const known = await demoSources(tx, ids);
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new ApiError(
        422,
        'validation_error',
        'a demo block names a demo that is not on this site; insert it again',
        {
          path,
          missing,
        },
      );
    }
  }

  const after = await refsIn(files);
  const folders = demoFolders(files);
  for (const { path, refs } of after) {
    for (const ref of refs) {
      if (ref.kind === 'repo' && !folders.get(ref.name)?.has('index.html')) {
        throw new ApiError(422, 'validation_error', `${path} shows ${DEMOS_DIR}/${ref.name}, which has no index.html`, {
          path,
        });
      }
    }
  }

  if (touchesDemos) {
    // Either section can show a folder, and the community can add one; once the author section shows it,
    // what runs there is the authors' to say.
    const authorFolders = new Set(
      [...(await refsIn(headFiles, 'author')), ...after.filter(({ path }) => partOf(path) === 'author')].flatMap(
        ({ refs }) => refs.flatMap((ref) => (ref.kind === 'repo' ? [ref.name] : [])),
      ),
    );
    const { roles, migration } = check;
    for (const path of changed) {
      const demo = demoPath(path);
      if (demo && authorFolders.has(demo.name) && !(roles.owner || roles.admin || migration)) {
        throw new ApiError(
          403,
          'forbidden',
          `${DEMOS_DIR}/${demo.name} is shown in the author section, so only this paper's confirmed authors can change it`,
          { path },
        );
      }
    }
    let count = 0;
    const stored: string[] = [];
    let bytes = 0;
    for (const [name, folder] of folders) {
      if (!folder.has('index.html')) {
        throw new ApiError(422, 'validation_error', `${DEMOS_DIR}/${name} has no index.html`, {
          path: `${DEMOS_DIR}/${name}/index.html`,
        });
      }
      count += folder.size;
      for (const oid of folder.values()) {
        const size = check.newBlobBytes.get(oid);
        if (size === undefined) stored.push(oid);
        else bytes += size;
      }
    }
    if (count > MAX_DEMOS_FILES) {
      throw new ApiError(422, 'validation_error', `a page's demos can have at most ${MAX_DEMOS_FILES} files`);
    }
    for (const size of (await pageRepo(tx, check.pageId).sizes(stored)).values()) bytes += size;
    if (bytes > MAX_DEMOS_BYTES) {
      throw new ApiError(
        422,
        'validation_error',
        `a page's demos can add up to at most ${MAX_DEMOS_BYTES / 1024 / 1024} MB; put a larger one on GitHub`,
      );
    }
  }

  const before = new Set(githubUrls((await refsIn(headFiles)).flatMap(({ refs }) => refs)));
  const added = new Set(githubUrls(after.flatMap(({ refs }) => refs)).filter((url) => !before.has(url)));
  if (added.size > MAX_NEW_DEMO_URLS) throw tooManyDemoUrls();
  return [...added];
}

/** The pins for the addresses `checkDemos` found new to the page, from what `copyDemos` copied. */
export function pinsFor(added: readonly string[], snapshots: ReadonlyMap<string, string>): DemoPin[] {
  return added.map((url) => {
    const snapshotId = snapshots.get(url);
    // Only if the page changed between the copy and the lock, taking the address off and back on.
    if (!snapshotId) throw new ApiError(503, 'page_busy', 'the page changed while its demos were copied; try again');
    return { url, snapshotId };
  });
}

/** Pins each new address to its snapshot, for as long as it stays on the page. Added again, it is copied again. */
export async function pinDemos(tx: Writer, pageId: string, commit: string, pins: readonly DemoPin[]): Promise<void> {
  for (const { url, snapshotId } of pins) {
    await tx
      .insert(demoPins)
      .values({ pageId, url, snapshotId, commit: toBytes(commit) })
      .onConflictDoUpdate({
        target: [demoPins.pageId, demoPins.url],
        set: { snapshotId, commit: toBytes(commit), createdAt: sql`clock_timestamp()` },
      });
  }
}
