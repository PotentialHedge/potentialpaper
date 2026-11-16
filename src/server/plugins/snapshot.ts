import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pluginRefs, pluginSnapshots, type DemoFile } from '@/db/schema';
import { validateManifest, type PluginManifest } from '@/lib/plugins/manifest';
import { pluginBaseUrl } from '@/lib/plugins/origin';
import { MANIFEST_FILE, type PluginSource, sourceKey, sourceOwner } from '@/lib/plugins/sources';
import { ApiError } from '../api/errors';
import { downloadFiles, resolveCommit } from '../demos/github';
import { knownType } from '../demos/snapshot';
import { hasBlob, putBlob } from '../demos/store';
import type { TarFile } from '../demos/tar';

/**
 * A plugin's files, copied once from GitHub at a pinned commit (`handoffs/plugins.md` Phase 2). This is the demos
 * pipeline (`server/demos/`): the ref is resolved to a commit through git's ref listing, the files come from
 * codeload's tarball, and their bytes go to the same store (R2, or a local folder in development), by SHA-256. We
 * never run a build: the files are served as they are in the repo.
 *
 * Only files of the kinds the content domain serves are kept (the demos' list, which has `png`, `woff2` and `wasm`),
 * so a repo's sources and tooling are left behind; dot-folders and `node_modules` too. The manifest is checked when
 * the copy is taken, and a copy whose manifest has errors is refused, every problem listed.
 */

export const MAX_PLUGIN_FILES = 500;
export const MAX_PLUGIN_BYTES = 20 * 1024 * 1024;
export const MAX_PLUGIN_FILE_BYTES = 10 * 1024 * 1024;

/** A plugin's host label: a stable hash of its id, so it keeps its origin, and its storage, across versions. */
export function pluginHostLabel(pluginId: string): string {
  return `plugin-${createHash('sha256').update(`potentialpaper-plugin:${pluginId}`).digest('hex').slice(0, 20)}`;
}

export interface PluginSnapshot {
  source: string;
  commit: string;
  pluginId: string;
  host: string;
  manifest: PluginManifest;
  warnings: string[];
  files: Record<string, DemoFile>;
  totalBytes: number;
}

export function baseUrlOf(snapshot: Pick<PluginSnapshot, 'host' | 'commit'>): string {
  return pluginBaseUrl(snapshot.host, snapshot.commit);
}

function refuse(problems: string[]): never {
  const [first, ...rest] = problems;
  throw new ApiError(
    422,
    'validation_error',
    rest.length === 0
      ? `the plugin can't be installed: ${first}`
      : `the plugin can't be installed, for ${problems.length} reasons:\n${problems.join('\n')}`,
    { problems },
  );
}

/** Whether a file is one a plugin's copy keeps. */
function kept(path: string): boolean {
  if (path.split('/').some((part) => part.startsWith('.') || part === 'node_modules')) return false;
  return knownType(path) !== null;
}

/**
 * Check a plugin's files (relative to its folder), store their bytes, and record the snapshot. Idempotent: a
 * commit already copied returns what was recorded. Exported for tests and for the in-repo example plugin, whose
 * files come from disk rather than GitHub.
 */
export async function storePluginFiles(
  source: PluginSource & { kind: 'github' },
  commit: string,
  all: readonly TarFile[],
  database: Database = getDb(),
): Promise<PluginSnapshot> {
  const key = sourceKey(source);
  const known = await findSnapshot(key, commit, database);
  if (known) return known;

  const problems: string[] = [];
  const manifestFile = all.find((file) => file.path === MANIFEST_FILE);
  if (!manifestFile) {
    refuse([
      `there's no ${MANIFEST_FILE} in ${source.path ? `the folder ${source.path}` : "the repo's top folder"} at ${commit.slice(0, 7)}`,
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(manifestFile.bytes.toString('utf8'));
  } catch (e) {
    refuse([`${MANIFEST_FILE} isn't JSON: ${(e as Error).message}`]);
  }
  const report = validateManifest(raw);
  problems.push(...report.errors.map((e) => `${MANIFEST_FILE}: ${e}`));
  const manifest = report.manifest;
  const owner = sourceOwner(source)!;
  if (manifest && manifest.id.split('/')[0] !== owner) {
    problems.push(
      `${MANIFEST_FILE}: id: "${manifest.id}" must start with the repo's owner, as "${owner}/${manifest.id.split('/')[1]}"`,
    );
  }

  const files = all.filter((file) => kept(file.path));
  if (manifest && !files.some((file) => file.path === manifest.main)) {
    problems.push(`${MANIFEST_FILE}: main: there's no ${manifest.main} in the plugin's folder; commit the built files`);
  }
  if (files.length > MAX_PLUGIN_FILES)
    problems.push(`a plugin has at most ${MAX_PLUGIN_FILES} files (${files.length})`);
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += file.bytes.length;
    if (file.bytes.length > MAX_PLUGIN_FILE_BYTES) {
      problems.push(`${file.path} is larger than ${MAX_PLUGIN_FILE_BYTES / 1024 / 1024} MB`);
    }
  }
  if (totalBytes > MAX_PLUGIN_BYTES) {
    problems.push(`its files add up to more than ${MAX_PLUGIN_BYTES / 1024 / 1024} MB`);
  }
  if (problems.length > 0 || !manifest) refuse(problems);

  const manifestFiles: Record<string, DemoFile> = {};
  for (const file of files) {
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    manifestFiles[file.path] = { sha256, bytes: file.bytes.length, type: knownType(file.path)! };
  }
  // Bytes first, so a snapshot row never names a file that isn't stored.
  const queue = [...files];
  const upload = async () => {
    for (let file = queue.pop(); file; file = queue.pop()) {
      const { sha256 } = manifestFiles[file.path];
      if (!(await hasBlob(sha256))) await putBlob(sha256, file.bytes);
    }
  };
  await Promise.all(Array.from({ length: 8 }, upload));

  const snapshot: PluginSnapshot = {
    source: key,
    commit,
    pluginId: manifest.id,
    host: pluginHostLabel(manifest.id),
    manifest,
    warnings: report.warnings,
    files: manifestFiles,
    totalBytes,
  };
  const inserted = await database
    .insert(pluginSnapshots)
    .values({ ...snapshot, manifest: manifest as unknown as Record<string, unknown> })
    .onConflictDoNothing()
    .returning({ source: pluginSnapshots.source });
  if (inserted.length === 0) {
    const raced = await findSnapshot(key, commit, database);
    if (raced) return raced;
    refuse([`another plugin with the id ${manifest.id} is already installed from this commit`]);
  }
  return snapshot;
}

function fromRow(row: typeof pluginSnapshots.$inferSelect): PluginSnapshot {
  return { ...row, manifest: row.manifest as unknown as PluginManifest };
}

export async function findSnapshot(
  source: string,
  commit: string,
  database: Database = getDb(),
): Promise<PluginSnapshot | null> {
  const [row] = await database
    .select()
    .from(pluginSnapshots)
    .where(and(eq(pluginSnapshots.source, source), eq(pluginSnapshots.commit, commit)));
  return row ? fromRow(row) : null;
}

/** The commit a source's ref was pinned to, if it has been resolved. Never fetches. */
export async function pinnedCommit(source: string, ref: string, database: Database = getDb()): Promise<string | null> {
  const [row] = await database
    .select({ commit: pluginRefs.commit })
    .from(pluginRefs)
    .where(and(eq(pluginRefs.source, source), eq(pluginRefs.ref, ref)));
  return row?.commit ?? null;
}

/** The snapshot a source at a ref runs, if it has been taken. Never fetches. */
export async function pinnedSnapshot(
  source: string,
  ref: string,
  database: Database = getDb(),
): Promise<PluginSnapshot | null> {
  const commit = await pinnedCommit(source, ref, database);
  return commit ? findSnapshot(source, commit, database) : null;
}

/** Fetches in flight, so many readers of one new plugin start one download. */
const inflight = new Map<string, Promise<PluginSnapshot>>();

/**
 * The snapshot of a GitHub source at its ref: the one pinned already, or else the ref resolved to a commit (and
 * pinned), and the files at that commit copied. `update` resolves the ref again even if it was pinned.
 */
export async function snapshotPlugin(
  source: PluginSource & { kind: 'github' },
  options: { update?: boolean; database?: Database } = {},
): Promise<PluginSnapshot> {
  const { update = false, database = getDb() } = options;
  const key = sourceKey(source);
  const ref = source.ref ?? '';
  if (!update) {
    const pinned = await pinnedSnapshot(key, ref, database);
    if (pinned) return pinned;
  }
  const flight = `${key}@${ref}${update ? ' update' : ''}`;
  const running = inflight.get(flight);
  if (running) return running;
  const work = (async () => {
    const pinned = update ? null : await pinnedCommit(key, ref, database);
    let commit = pinned;
    if (!commit) {
      // A full commit id needs no lookup; a ref goes through git's ref listing, which needs no token.
      commit = /^[0-9a-f]{40}$/.test(ref)
        ? ref
        : (await resolveCommit({ kind: 'repo', owner: source.owner, repo: source.repo, rest: ref })).commit;
    }
    let snapshot = await findSnapshot(key, commit, database);
    if (!snapshot) {
      const files = await downloadFiles(
        { kind: 'repo', owner: source.owner, repo: source.repo, rest: '' },
        commit,
        source.path,
      );
      const prefix = source.path ? `${source.path}/` : '';
      snapshot = await storePluginFiles(
        source,
        commit,
        files.map((file) => ({ path: file.path.slice(prefix.length), bytes: file.bytes })),
        database,
      );
    }
    await database
      .insert(pluginRefs)
      .values({ source: key, ref, commit })
      .onConflictDoUpdate({ target: [pluginRefs.source, pluginRefs.ref], set: { commit, resolvedAt: new Date() } });
    return snapshot;
  })();
  inflight.set(flight, work);
  try {
    return await work;
  } finally {
    inflight.delete(flight);
  }
}

/** Pin a source's ref to a commit already copied, as installing does; for tests and the example plugin. */
export async function pinPlugin(source: string, ref: string, commit: string, database: Database = getDb()) {
  await database
    .insert(pluginRefs)
    .values({ source, ref, commit })
    .onConflictDoUpdate({ target: [pluginRefs.source, pluginRefs.ref], set: { commit, resolvedAt: new Date() } });
}
