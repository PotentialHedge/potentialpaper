import { eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageCurrent, pdfDocuments } from '@/db/schema';
import {
  encodeVersionFile,
  newVersionId,
  sortVersions,
  versionProblem,
  type PaperVersion,
  type VersionPdf,
  type VersionSubmission,
} from '@/lib/versions';
import { diffShort, diffTexts, type DiffPart, type TextDiff } from '@/lib/text-diff';
import { ApiError } from './api/errors';
import { versionPdfAt } from './files';
import { commitPage, type Actor, type CommitOptions, type CommitResult } from './pages/commit';
import { readVersions, versionChanges } from './pages/content';
import { findCommit, readCommit, readFiles, readHead, type Reader } from './pages/repo';

/**
 * A paper's versions (`lib/versions.ts`), kept in its page's `versions/`, a file each. They are saved as a
 * whole list, against the commit the editor loaded, so `commitPage`'s three-way merge keeps what anyone
 * else changed meanwhile: a file per version means two people editing different versions don't conflict.
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
  return { head, versions: await readVersions(database, paperId, await readFiles(database, paperId, commit.tree)) };
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

function cleanSubmission(input: VersionSubmission): VersionSubmission {
  const evidence = [...new Set((input.evidence ?? []).map((url) => url.trim()).filter(Boolean))];
  const page = clean(input.page);
  const out: VersionSubmission = {
    // A venue page's name is the page's: the name read back with it (`page_current.versions`) isn't stored again.
    venue: page ? undefined : (clean(input.venue) ?? ''),
    page,
    status: input.status ?? undefined,
    decision: clean(input.decision),
    site: clean(input.site),
    number: input.number ?? undefined,
    url: clean(input.url),
    reviews: input.reviews ?? undefined,
    evidence: evidence.length > 0 ? evidence : undefined,
  };
  for (const key of Object.keys(out) as (keyof VersionSubmission)[]) if (out[key] === undefined) delete out[key];
  return out;
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
      submissions: input.submissions?.length ? input.submissions.map(cleanSubmission) : undefined,
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

/** Replaces the versions, merged with whatever changed since `baseOid`. An empty list removes them all. */
export async function setVersions(
  paperId: string,
  actor: Actor,
  edit: VersionsEdit,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const database = options.database ?? getDb();
  const { versions: before } = await versionsAt(paperId, edit.baseOid, database);
  const versions = await resolve(edit.versions, before, database);
  // Against the commit the list was loaded at: the files of versions someone else changed since are left
  // alone, and one both changed is merged by line, a field to a line, or is a conflict.
  return commitPage(
    paperId,
    edit.baseOid,
    actor,
    versionChanges(before, versions),
    edit.summary?.trim() || summarize(before, versions),
    { ...options, database, evidence: edit.evidence ?? options.evidence },
  );
}

/** Equal as the file would store them, whatever order their fields were given in. */
const same = (a: PaperVersion | undefined, b: PaperVersion | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.id === b.id && encodeVersionFile(a) === encodeVersionFile(b));

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
    .where(eq(pageCurrent.pageId, paperId));
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
 * Whether two submissions name the same venue: by page when both name one, by name when both name none. One naming a
 * page and one a name may still be the same venue, so the forum's address decides alone.
 */
function sameVenue(a: VersionSubmission, b: VersionSubmission): boolean {
  if (a.page && b.page) return a.page === b.page;
  if (!a.page && !b.page) return a.venue === b.venue;
  return true;
}

/** `was` with `next` laid over it, naming its venue once: by its page when either names one. */
function overlaySubmission(was: VersionSubmission, next: VersionSubmission): VersionSubmission {
  const out: VersionSubmission = { ...was, ...next };
  if (out.page) delete out.venue;
  return out;
}

/**
 * A version's submissions with the ones a lookup found: one at the same forum takes what the source says now, unless
 * a bot imported its reviews (`reviews`), whose entry only that bot changes; the rest are added.
 */
function mergeSubmissions(
  was: readonly VersionSubmission[] | undefined,
  found: readonly VersionSubmission[] | undefined,
): VersionSubmission[] | undefined {
  const out = (was ?? []).map((s) => ({ ...s }));
  for (const submission of found ?? []) {
    const at = out.findIndex((s) => sameUrl(s.url) === sameUrl(submission.url) && sameVenue(s, submission));
    if (at === -1) out.push({ ...submission });
    else if (!out[at].reviews) out[at] = overlaySubmission(out[at], submission);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Found versions folded into the ones the page has: one already there (by its address) takes what the
 * source says now, such as a decision, and keeps its id, its note and its evidence; the rest are added,
 * without ids. Returned in the editor's input form, PDFs by address.
 */
export function mergeFoundVersions(
  existing: readonly PaperVersion[],
  found: readonly (Omit<PaperVersion, 'id'> & { url: string })[],
  { relabel = false }: { relabel?: boolean } = {},
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
      // A label someone wrote is kept, unless an import's naming is being corrected.
      label: (relabel ? version.label : was.label) || version.label,
      note: was.note,
      pdf: was.pdf ?? version.pdf,
      submissions: mergeSubmissions(was.submissions, version.submissions),
      evidence: [...new Set([...(was.evidence ?? []), ...(version.evidence ?? [])])],
    };
    if (!out[at].submissions) delete out[at].submissions;
  }
  return sortVersions(out);
}

/**
 * The versions with a bot's submission recorded where it belongs: the entry already naming its reviews is brought
 * up to date; else an entry someone added for the same forum gains the link; else the version at that forum gains
 * the entry; else a new `submitted` version is made for it. The one place an import writes a decision.
 */
export function attachSubmission(
  versions: readonly PaperVersion[],
  entry: VersionSubmission & { url: string; reviews: string },
  {
    date,
    label,
    newId = newVersionId,
  }: {
    /** When it was submitted (`YYYY-MM-DD`): the date of a version made for it, or of one that has none. */
    date?: string;
    /** The label of a version made for it: the venue's name, which an entry naming its page doesn't hold. */
    label?: string;
    newId?: () => string;
  } = {},
): PaperVersion[] {
  const out: PaperVersion[] = versions.map((v) => ({ ...v, submissions: v.submissions?.map((s) => ({ ...s })) }));
  const merge = (was: VersionSubmission): VersionSubmission => {
    const next = overlaySubmission(was, entry);
    const evidence = [...new Set([...(was.evidence ?? []), ...(entry.evidence ?? [])])];
    if (evidence.length > 0) next.evidence = evidence;
    // What the source no longer says is gone, not kept from before.
    for (const key of ['status', 'decision', 'number'] as const) if (entry[key] === undefined) delete next[key];
    return next;
  };
  const find = (match: (s: VersionSubmission) => boolean) => {
    for (const v of out) {
      const at = v.submissions?.findIndex(match) ?? -1;
      if (at !== -1) return { v, at };
    }
    return null;
  };
  const hit =
    find((s) => s.reviews === entry.reviews) ?? find((s) => !s.reviews && sameUrl(s.url) === sameUrl(entry.url));
  let version: PaperVersion | undefined;
  if (hit) {
    hit.v.submissions![hit.at] = merge(hit.v.submissions![hit.at]);
    version = hit.v;
  } else {
    version = out.find((v) => sameUrl(v.url) === sameUrl(entry.url));
    if (version) version.submissions = [...(version.submissions ?? []), entry];
    else {
      version = {
        id: newId(),
        label: label ?? entry.venue ?? entry.page ?? 'Submission',
        kind: 'submitted',
        url: entry.url,
        submissions: [entry],
        evidence: [entry.url],
      };
      out.push(version);
    }
  }
  // A date someone gave the version stands; the source's fills one in that has none.
  if (date && !version.date) version.date = date;
  for (const v of out) if (!v.submissions?.length) delete v.submissions;
  return sortVersions(out);
}

/**
 * The versions with a PDF given to the version at `url` (its own address, or a venue's forum one of its submissions
 * names), or to a new version there when none is. Every PDF of a paper is a version's.
 */
export function attachPdf(
  versions: readonly PaperVersion[],
  pdf: VersionPdf,
  at: { url: string; label: string; kind?: PaperVersion['kind'] },
  newId: () => string = newVersionId,
): PaperVersion[] {
  const out = versions.map((v) => ({ ...v }));
  const version =
    out.find((v) => sameUrl(v.url) === sameUrl(at.url)) ??
    out.find((v) => v.submissions?.some((s) => sameUrl(s.url) === sameUrl(at.url)));
  if (version) version.pdf = pdf;
  else out.push({ id: newId(), label: at.label, kind: at.kind ?? 'submitted', url: at.url, pdf, evidence: [at.url] });
  return sortVersions(out);
}
