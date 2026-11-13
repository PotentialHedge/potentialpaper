import { eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, commitIdentities } from '@/db/schema';
import { ApiError } from '../api/errors';
import { claimNames } from '../claims';
import { checkedDemoSources } from '../demos/attach';
import { commitPage, type Actor, type CommitOptions, type CommitResult } from './commit';
import { SYSTEM_AUTHOR_ID } from './git-objects';
import { AUTHOR_STARTER, COMMUNITY_STARTER, splitSections } from './markdown';
import { findCommit, pageHistory, readFiles, readHead, type PublicRevision, type Reader } from './repo';
import type { PagePart, SectionFormat } from './rules';
import { joinSections, planSections, readSections, sectionTitle, type SectionFile } from './sections';

export { PAGE_PARTS, type PagePart } from './rules';

const PART_STARTER: Record<PagePart, string> = { author: AUTHOR_STARTER, community: COMMUNITY_STARTER };
const PART_NAME: Record<PagePart, string> = { author: 'author section', community: 'community section' };

/**
 * Editing the author or community part a section at a time, as a wiki does. Each section is a file
 * (`sections.ts`), so editing one is editing its file. The editor sends the section it loaded and the
 * commit it loaded it at; the server makes the change against the files *as they were at that commit*,
 * so `commitPage`'s three-way merge sees exactly what this person changed, and edits since then merge in.
 */

/** The part's sections at a commit; none if there is no commit. */
async function sectionsAt(db: Reader, paperId: string, part: PagePart, oid: string | null): Promise<SectionFile[]> {
  if (!oid) return [];
  const commit = await findCommit(db, paperId, oid);
  if (!commit) throw new ApiError(422, 'validation_error', 'the base is not a commit of this page');
  return readSections(db, paperId, await readFiles(db, paperId, commit.tree), part);
}

/** The whole part is edited as one Markdown text, which an HTML section can't be part of. */
function wholePartProblem(sections: readonly SectionFile[]): ApiError | null {
  return sections.some((s) => s.name.format === 'html')
    ? new ApiError(422, 'validation_error', 'this part has HTML sections, so edit its sections one at a time')
    : null;
}

export interface EditorState {
  part: PagePart;
  /** The commit the text was read at, which the edit is sent back with. */
  baseOid: string | null;
  section: number;
  /** The section's heading, or `null` for the whole part. */
  title: string | null;
  /** The section's file, or `null` for the whole part. */
  path: string | null;
  format: SectionFormat;
  text: string;
  /** The part is empty yet, and `text` is the starter. */
  starter: boolean;
}

/** What the editor opens with, or `null` if the page has no such section. */
export async function editorState(
  paperId: string,
  part: PagePart,
  section: number,
  database: Database = getDb(),
): Promise<EditorState | null> {
  const baseOid = await readHead(database, paperId);
  const sections = await sectionsAt(database, paperId, part, baseOid);
  const whole = { part, baseOid, section, title: null, path: null, format: 'markdown' as const };
  if (sections.length === 0) {
    return section === 0 ? { ...whole, text: PART_STARTER[part], starter: true } : null;
  }
  if (section === 0) {
    const problem = wholePartProblem(sections);
    if (problem) throw problem;
    return { ...whole, text: joinSections(sections), starter: false };
  }
  const found = sections[section - 1];
  if (!found) return null;
  return {
    part,
    baseOid,
    section,
    title: sectionTitle(found),
    path: found.path,
    format: found.name.format,
    text: found.text,
    starter: false,
  };
}

/**
 * The section that is now where this one was: the same file, or else the one with its title, or else at
 * its place. If there is none, the whole part, as section 0.
 */
function sectionNow(
  base: readonly SectionFile[],
  section: number,
  current: readonly SectionFile[],
): { section: number; text: string } {
  const whole = { section: 0, text: joinSections(current) };
  const was = base[section - 1];
  if (section === 0 || !was) return whole;
  let at = current.findIndex((s) => s.path === was.path);
  if (at === -1) at = current.findIndex((s) => sectionTitle(s) === sectionTitle(was));
  if (at === -1 && section <= current.length) at = section - 1;
  return at === -1 ? whole : { section: at + 1, text: current[at].text };
}

/** What an edit is called when its summary is left blank: the section's heading, as a wiki does. */
function defaultSummary(part: PagePart, base: readonly SectionFile[], section: number): string {
  if (base.length === 0) return `Start the ${PART_NAME[part]}`;
  const found = section > 0 ? base[section - 1] : undefined;
  return found ? `Edit “${sectionTitle(found)}”` : `Edit the ${PART_NAME[part]}`;
}

export interface SectionEdit {
  part: PagePart;
  baseOid: string | null;
  section: number;
  content: string;
  summary: string;
}

/**
 * Commits one section's new text, or the whole part's. New `#` headings in Markdown make new sections,
 * and an emptied section is removed. A conflict is `409 edit_conflict` with, besides every version of the
 * files, `current`: the head and the section as it is there, for the editor to show beside this text.
 */
export async function editSection(
  paperId: string,
  actor: Actor,
  edit: SectionEdit,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const database = options.database ?? getDb();
  const base = await sectionsAt(database, paperId, edit.part, edit.baseOid);
  const target = edit.section === 0 ? null : base[edit.section - 1];
  if (edit.section > 0 && !target) throw new ApiError(422, 'validation_error', 'that section is not on the page');
  if (!target) {
    const problem = wholePartProblem(base);
    if (problem) throw problem;
  }
  // An HTML section is one file as it was typed; Markdown is cut at its `#` headings.
  const html = target?.name.format === 'html';
  if (!html) await checkedDemoSources(edit.content, database);
  const parts = html ? [{ title: null, text: edit.content }] : splitSections(edit.content);
  const changes = target
    ? planSections(base, edit.part, edit.section - 1, edit.section, parts)
    : planSections(base, edit.part, 0, base.length, parts);
  try {
    return await commitPage(
      paperId,
      edit.baseOid,
      actor,
      changes,
      edit.summary.trim() || defaultSummary(edit.part, base, edit.section),
      { ...options, database },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'edit_conflict') throw err;
    const head = await readHead(database, paperId);
    const current = sectionNow(base, edit.section, await sectionsAt(database, paperId, edit.part, head));
    throw new ApiError(409, 'edit_conflict', err.message, { ...err.details, current: { head, ...current } });
  }
}

export interface HistoryEntry extends PublicRevision {
  /** Who made it: a handle, or `null` for the system or one of the paper's authors. */
  handle: string | null;
  /** One of the paper's confirmed authors, by the name on the paper: their handle never shows here. */
  authorName: string | null;
}

/**
 * A page's history with each commit's handle. **Public:** commit identities are looked up to handles, and
 * nothing here selects an account id.
 */
export async function historyWithHandles(
  paperId: string,
  options: { limit?: number; beforeSeq?: number; database?: Database } = {},
): Promise<HistoryEntry[]> {
  const database = options.database ?? getDb();
  const revisions = await pageHistory(paperId, { ...options, database });
  const ids = revisions.map((r) => r.authorId);
  const [handles, names] = await Promise.all([handlesOf(ids, database), claimNames(ids, database)]);
  return revisions.map((revision) => ({
    ...revision,
    handle: handles.get(revision.authorId) ?? null,
    authorName: names.get(revision.authorId) ?? null,
  }));
}

/** Handles by commit identity. Only the two columns cross: the account id stays in the join. */
export async function handlesOf(
  authorIds: readonly string[],
  database: Database = getDb(),
): Promise<Map<string, string>> {
  const ids = [...new Set(authorIds)].filter((id) => id !== SYSTEM_AUTHOR_ID && id.startsWith('u_'));
  if (ids.length === 0) return new Map();
  const rows = await database
    .select({ id: commitIdentities.id, handle: accounts.handle })
    .from(commitIdentities)
    .innerJoin(accounts, eq(accounts.id, commitIdentities.accountId))
    .where(inArray(commitIdentities.id, ids));
  return new Map(rows.map((row) => [row.id, row.handle]));
}
