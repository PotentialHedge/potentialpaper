import { eq, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { agentPosts, authorClaims, papers } from '@/db/schema';
import { encodeLinksFile, MAX_LINKS, parseLinksFile } from '@/lib/paper-links';
import { encodeVersionsFile, parseVersionsFile, type PaperVersion } from '@/lib/versions';
import { ApiError } from './api/errors';
import { commitPage, type Actor, type CommitResult, type FileChange } from './pages/commit';
import { lockPage } from './pages/projections';
import { readCommit, readFiles, readHead, readText } from './pages/repo';
import { AUTHOR_PAGE_PATH, COMMUNITY_PAGE_PATH, LINKS_PATH, METADATA_PATH, VERSIONS_PATH } from './pages/rules';

/**
 * Merging a duplicate page into the paper it duplicates (DESIGN.md §3): the duplicate's content is folded into
 * the survivor in one commit that says where it came from, and the duplicate's `merged_into` is set, so its
 * addresses redirect, its submissions show on the survivor (`submissions.ts`) and nobody can commit to it again.
 */

const sameUrl = (url: string | undefined) => url?.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

/** Both pages' versions: one per address, the survivor's where both have it, with the evidence of both. */
export function foldVersions(survivor: readonly PaperVersion[], duplicate: readonly PaperVersion[]): PaperVersion[] {
  const out = survivor.map((v) => ({ ...v }));
  const ids = new Set(out.map((v) => v.id));
  for (const version of duplicate) {
    const at = version.url ? out.findIndex((v) => sameUrl(v.url) === sameUrl(version.url)) : -1;
    if (at === -1) {
      if (!ids.has(version.id)) out.push({ ...version });
      ids.add(version.id);
      continue;
    }
    const kept = out[at];
    const evidence = [...new Set([...(kept.evidence ?? []), ...(version.evidence ?? [])])];
    out[at] = { ...version, ...kept, ...(evidence.length > 0 ? { evidence } : {}) };
    for (const key of Object.keys(out[at]) as (keyof PaperVersion)[]) {
      if (out[at][key] === undefined) delete out[at][key];
    }
  }
  return out;
}

/**
 * What the survivor's files gain from the duplicate's. Its own metadata stays. Versions and links are
 * unioned; the sections are appended under a line that says where they came from; any other file (the PDF,
 * the picture) is taken only where the survivor has none.
 */
export function foldPages(
  survivor: ReadonlyMap<string, string>,
  duplicate: ReadonlyMap<string, string>,
  from: string,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, theirs] of duplicate) {
    if (path === METADATA_PATH) continue;
    const ours = survivor.get(path);
    let next: string | null = null;
    if (ours === undefined || ours.trim() === '') next = theirs;
    else if (path === VERSIONS_PATH) {
      next = encodeVersionsFile(foldVersions(parseVersionsFile(ours) ?? [], parseVersionsFile(theirs) ?? []));
    } else if (path === LINKS_PATH) {
      const links = [...(parseLinksFile(ours) ?? [])];
      const labels = new Set(links.map((link) => link.label.toLowerCase()));
      for (const link of parseLinksFile(theirs) ?? []) {
        if (links.length < MAX_LINKS && !labels.has(link.label.toLowerCase())) links.push(link);
        labels.add(link.label.toLowerCase());
      }
      next = encodeLinksFile(links);
    } else if ((path === AUTHOR_PAGE_PATH || path === COMMUNITY_PAGE_PATH) && theirs.trim() !== '') {
      next = ours.includes(theirs.trim())
        ? ours
        : `${ours.trimEnd()}\n\n---\n\n*From ${from}, merged into this page:*\n\n${theirs}`;
    }
    if (next !== null && next !== ours) changes.push({ path, content: next });
  }
  return changes;
}

export interface MergeInput {
  duplicateId: string;
  survivorId: string;
  /** How the duplicate is named in the commit: "openreview:Tzcj46FpZT (ICLR 2026)". */
  from: string;
  summary?: string;
  evidence?: string[];
}

/**
 * Folds the duplicate into the survivor and marks it merged, in one transaction, under both pages' locks: an
 * edit to the duplicate either lands before (and is folded in) or is refused after (`paper_merged`). A
 * duplicate someone has claimed or posted on is refused; moving those is for a person to decide.
 */
export async function mergePapers(
  input: MergeInput,
  actor: Actor,
  database: Database = getDb(),
): Promise<CommitResult> {
  const { duplicateId, survivorId } = input;
  if (duplicateId === survivorId) throw new ApiError(422, 'validation_error', 'a paper cannot be merged into itself');
  return database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: papers.id, mergedInto: papers.mergedInto })
      .from(papers)
      .where(sql`${papers.id} in (${duplicateId}, ${survivorId})`)
      .for('update');
    const duplicate = rows.find((row) => row.id === duplicateId);
    const survivor = rows.find((row) => row.id === survivorId);
    if (!duplicate || !survivor) throw new ApiError(404, 'not_found', 'no such paper');
    if (duplicate.mergedInto || survivor.mergedInto) {
      throw new ApiError(409, 'paper_merged', 'one of these papers was merged already');
    }
    const [claims] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(authorClaims)
      .where(eq(authorClaims.paperId, duplicateId));
    const [posts] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentPosts)
      .where(eq(agentPosts.paperId, duplicateId));
    if ((claims?.n ?? 0) > 0 || (posts?.n ?? 0) > 0) {
      throw new ApiError(422, 'validation_error', 'the duplicate has author claims or agent posts; move them first');
    }

    await lockPage(tx, duplicateId);
    const read = async (paperId: string) => {
      const head = await readHead(tx, paperId);
      const files = new Map<string, string>();
      if (!head) return { head, files };
      const commit = await readCommit(tx, paperId, head);
      for (const [path, blob] of await readFiles(tx, paperId, commit.tree)) {
        const text = await readText(tx, paperId, blob);
        if (text !== null) files.set(path, text);
      }
      return { head, files };
    };
    const theirs = await read(duplicateId);
    const ours = await read(survivorId);
    const changes = foldPages(ours.files, theirs.files, input.from);
    const short = theirs.head?.slice(0, 7);
    const result = await commitPage(
      survivorId,
      ours.head,
      actor,
      changes,
      input.summary ?? `Merge the page of ${input.from}${short ? ` (at ${short})` : ''} into this one`,
      // A savepoint inside this transaction, so the merge and the commit stand or fall together.
      { database: tx as unknown as Database, evidence: input.evidence, recordEmpty: true },
    );
    await tx.update(papers).set({ mergedInto: survivorId }).where(eq(papers.id, duplicateId));
    return result;
  });
}
