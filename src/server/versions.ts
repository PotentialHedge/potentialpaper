import { eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent, pdfDocuments } from '@/db/schema';
import {
  encodeVersionsFile,
  newVersionId,
  parseVersionsFile,
  sortVersions,
  versionProblem,
  type PaperVersion,
  type VersionPdf,
} from '@/lib/versions';
import { diffShort, diffTexts, type DiffPart, type TextDiff } from '@/lib/text-diff';
import { ApiError } from './api/errors';
import { versionPdfAt } from './files';
import { commitPage, type Actor, type CommitOptions, type CommitResult } from './pages/commit';
import { findCommit, readCommit, readFiles, readHead, readText, type Reader } from './pages/repo';
import { VERSIONS_PATH } from './pages/rules';

/**
 * A paper's versions (`lib/versions.ts`), kept in its page's `versions.jsonl`. They are saved as a whole
 * list, against the commit the editor loaded, so `commitPage`'s three-way merge keeps what anyone else
 * changed meanwhile: one line per version means two people editing different versions don't conflict.
 */

/** The versions at a commit (the head by default), and that commit. */
export async function versionsAt(
  paperId: string,
  oid?: string | null,
  database: Reader = getDb(),
): Promise<{ head: string | null; versions: PaperVersion[] }> {
  const head = oid === undefined ? await readHead(database, paperId) : oid;
  if (!head) return { head: null, versions: [] };
  const commit =
    oid === undefined ? await readCommit(database, paperId, head) : await findCommit(database, paperId, head);
  if (!commit) throw new ApiError(422, 'validation_error', 'the base is not a commit of this page');
  const text = await readText(database, paperId, (await readFiles(database, paperId, commit.tree)).get(VERSIONS_PATH));
  return { head, versions: text === null ? [] : (parseVersionsFile(text) ?? []) };
}

/** A version as an editor or an agent sends it: its PDF named by the address it was uploaded to. */
export type VersionInput = Omit<PaperVersion, 'id' | 'pdf'> & {
  id?: string;
  pdf?: { url: string; license?: string | null } | null;
};

function clean(text: string | undefined | null, multiline = false): string | undefined {
  if (text === undefined || text === null) return undefined;
  const value = (multiline ? text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : text.replace(/\s+/g, ' ')).trim();
  return value === '' ? undefined : value;
}

/** Each input as a version: ids for new ones, PDFs resolved to what we store, text trimmed. */
async function resolve(
  inputs: readonly VersionInput[],
  before: readonly PaperVersion[],
  database: Database,
): Promise<PaperVersion[]> {
  const known = new Map(before.map((v) => [v.id, v]));
  const ids = new Set<string>();
  const out: PaperVersion[] = [];
  for (const [index, input] of inputs.entries()) {
    let id = input.id;
    if (!id || ids.has(id))
      do id = newVersionId();
      while (ids.has(id));
    ids.add(id);
    let pdf: VersionPdf | undefined;
    if (input.pdf?.url) {
      const kept = known.get(id)?.pdf;
      pdf = kept && kept.url === input.pdf.url ? kept : await versionPdfAt(input.pdf.url, database);
      const license = clean(input.pdf.license);
      if (license) pdf = { ...pdf, license };
    }
    const evidence = [...new Set((input.evidence ?? []).map((url) => url.trim()).filter(Boolean))];
    const version: PaperVersion = {
      id,
      label: clean(input.label) ?? '',
      kind: input.kind,
      date: clean(input.date),
      status: input.status ?? undefined,
      decision: clean(input.decision),
      title: clean(input.title),
      abstract: clean(input.abstract, true),
      url: clean(input.url),
      pdf,
      note: clean(input.note, true),
      evidence: evidence.length > 0 ? evidence : undefined,
    };
    for (const key of Object.keys(version) as (keyof PaperVersion)[]) {
      if (version[key] === undefined) delete version[key];
    }
    const problem = versionProblem(version);
    if (problem) throw new ApiError(422, 'validation_error', `version ${index + 1} ${problem}`, { index });
    out.push(version);
  }
  return out;
}

export interface VersionsEdit {
  /** The commit the list was loaded at; `null` if the page had no repo then. */
  baseOid: string | null;
  versions: VersionInput[];
  summary?: string;
  evidence?: string[];
}

/** Replaces the versions, merged with whatever changed since `baseOid`. An empty list removes the file. */
export async function setVersions(
  paperId: string,
  actor: Actor,
  edit: VersionsEdit,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const database = options.database ?? getDb();
  const { versions: before } = await versionsAt(paperId, edit.baseOid, database);
  let versions = await resolve(edit.versions, before, database);
  // Merged a version at a time rather than a line at a time, so edits to neighbouring versions don't
  // conflict; `commitPage` still merges by line if the head moves again before it commits.
  let base = edit.baseOid;
  const head = await readHead(database, paperId);
  if (head !== base) {
    const { versions: theirs } = await versionsAt(paperId, head, database);
    versions = mergeVersionLists(before, versions, theirs);
    base = head;
  }
  const result = await commitPage(
    paperId,
    base,
    actor,
    [{ path: VERSIONS_PATH, content: versions.length > 0 ? encodeVersionsFile(versions) : null }],
    edit.summary?.trim() || summarize(before, versions),
    { ...options, database, evidence: edit.evidence ?? options.evidence },
  );
  return result.status === 'committed' && base !== edit.baseOid ? { ...result, merged: true } : result;
}

/** Equal as the file would store them, whatever order their fields were given in. */
const same = (a: PaperVersion | undefined, b: PaperVersion | undefined) =>
  a === b || (a !== undefined && b !== undefined && encodeVersionsFile([a]) === encodeVersionsFile([b]));

/**
 * A three-way merge of version lists by id: what one side changed since `base` is taken over the other's,
 * and a version both changed differently is `409 edit_conflict`. Order is by date, so it needs no merging.
 */
export function mergeVersionLists(
  base: readonly PaperVersion[],
  ours: readonly PaperVersion[],
  theirs: readonly PaperVersion[],
): PaperVersion[] {
  const byId = (list: readonly PaperVersion[]) => new Map(list.map((v) => [v.id, v]));
  const [b, o, t] = [byId(base), byId(ours), byId(theirs)];
  const ids = [...new Set([...theirs.map((v) => v.id), ...ours.map((v) => v.id)])];
  const merged: PaperVersion[] = [];
  const conflicts: string[] = [];
  for (const id of ids) {
    const [was, mine, other] = [b.get(id), o.get(id), t.get(id)];
    let kept: PaperVersion | undefined;
    if (same(mine, other) || same(mine, was)) kept = other;
    else if (same(other, was)) kept = mine;
    else {
      conflicts.push((mine ?? other ?? was)!.label);
      continue;
    }
    if (kept) merged.push(kept);
  }
  if (conflicts.length > 0) {
    throw new ApiError(409, 'edit_conflict', `someone else changed the same version: ${conflicts.join(', ')}`, {
      versions: conflicts,
    });
  }
  return sortVersions(merged);
}

/** "Add the version “ICLR 2027”", or what else changed, when the editor leaves the summary blank. */
function summarize(before: readonly PaperVersion[], after: readonly PaperVersion[]): string {
  const was = new Map(before.map((v) => [v.id, v]));
  const now = new Map(after.map((v) => [v.id, v]));
  const added = after.filter((v) => !was.has(v.id));
  const removed = before.filter((v) => !now.has(v.id));
  const changed = after.filter((v) => was.has(v.id) && !same(was.get(v.id), v));
  const name = (list: PaperVersion[]) => list.map((v) => `“${v.label}”`).join(', ');
  const parts = [
    added.length ? `Add the version${added.length > 1 ? 's' : ''} ${name(added)}` : null,
    changed.length ? `Change ${name(changed)}` : null,
    removed.length ? `Remove ${name(removed)}` : null,
  ].filter(Boolean);
  return parts.join('; ') || 'Change the versions';
}

/** The versions a page shows, oldest first, from its projection. */
export async function currentVersions(paperId: string, database: Database = getDb()): Promise<PaperVersion[]> {
  const [row] = await database
    .select({ versions: pageCurrent.versions })
    .from(pageCurrent)
    .where(eq(pageCurrent.paperId, paperId));
  return sortVersions(row?.versions ?? []);
}

export interface Comparison {
  a: PaperVersion;
  b: PaperVersion;
  title: DiffPart[] | null;
  abstract: DiffPart[] | null;
  /**
   * The PDFs' text: a diff, or why there is none. `pending` means a PDF's text hasn't been extracted yet,
   * which the ingest service does within a minute or two of a PDF being added.
   */
  text:
    | { status: 'diff'; diff: TextDiff; pages: [number | null, number | null] }
    | { status: 'same' }
    | { status: 'no_pdf'; missing: ('a' | 'b')[] }
    | { status: 'pending' }
    | { status: 'too_different' };
}

/**
 * Two versions of a paper side by side. The paper's title and abstract stand in for a version that doesn't
 * give its own.
 */
export async function compareVersions(
  paperId: string,
  ids: { a: string; b: string },
  paper: { title: string; abstract: string | null },
  database: Database = getDb(),
): Promise<Comparison | null> {
  const versions = await currentVersions(paperId, database);
  const a = versions.find((v) => v.id === ids.a);
  const b = versions.find((v) => v.id === ids.b);
  if (!a || !b) return null;
  const title = diffShort(a.title ?? paper.title, b.title ?? paper.title);
  const abstract =
    a.abstract || b.abstract ? diffShort(a.abstract ?? paper.abstract ?? '', b.abstract ?? paper.abstract ?? '') : null;
  return { a, b, title, abstract, text: await compareText(a, b, database) };
}

async function compareText(a: PaperVersion, b: PaperVersion, database: Database): Promise<Comparison['text']> {
  const missing = (['a', 'b'] as const).filter((side) => !(side === 'a' ? a : b).pdf);
  if (missing.length > 0) return { status: 'no_pdf', missing };
  if (a.pdf!.sha256 === b.pdf!.sha256) return { status: 'same' };
  const rows = await database
    .select({ sha256: pdfDocuments.sha256, fullText: pdfDocuments.fullText, pages: pdfDocuments.pages })
    .from(pdfDocuments)
    .where(inArray(pdfDocuments.sha256, [a.pdf!.sha256, b.pdf!.sha256]));
  const of = (sha: string) => rows.find((row) => row.sha256 === sha);
  const left = of(a.pdf!.sha256);
  const right = of(b.pdf!.sha256);
  if (left?.fullText == null || right?.fullText == null) return { status: 'pending' };
  const diff = diffTexts(left.fullText, right.fullText);
  if (!diff) return { status: 'too_different' };
  return { status: 'diff', diff, pages: [left.pages, right.pages] };
}

/** The same address however it was written: `http`, `www.`, a trailing slash. */
function sameUrl(url: string | undefined): string {
  return (url ?? '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

/**
 * Found versions folded into the ones the page has: one already there (by its address) takes what the
 * source says now, such as a decision, and keeps its id, its note and its evidence; the rest are added,
 * without ids. Returned in the editor's input form, PDFs by address.
 */
export function mergeFoundVersions(
  existing: readonly PaperVersion[],
  found: readonly (Omit<PaperVersion, 'id'> & { url: string })[],
): (VersionInput & { pdf?: VersionPdf })[] {
  const out: (VersionInput & { pdf?: VersionPdf })[] = existing.map((v) => ({ ...v }));
  for (const version of found) {
    const at = out.findIndex((v) => sameUrl(v.url) === sameUrl(version.url));
    if (at === -1) {
      out.push({ ...version });
      continue;
    }
    const was = out[at];
    out[at] = {
      ...was,
      ...version,
      id: was.id,
      label: was.label || version.label,
      note: was.note,
      pdf: was.pdf ?? version.pdf,
      evidence: [...new Set([...(was.evidence ?? []), ...(version.evidence ?? [])])],
    };
  }
  return sortVersions(out);
}
