import { eq, inArray } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, commitIdentities } from '@/db/schema';
import { ApiError } from '../api/errors';
import { claimNames } from '../claims';
import { checkedDemoSources } from '../demos/attach';
import { commitPage, type Actor, type CommitOptions, type CommitResult } from './commit';
import { SYSTEM_AUTHOR_ID } from './git-objects';
import { AUTHOR_STARTER, COMMUNITY_STARTER, replaceSection, splitSections } from './markdown';
import { findCommit, pageHistory, readFiles, readHead, readText, type PublicRevision, type Reader } from './repo';
import { AUTHOR_PAGE_PATH, COMMUNITY_PAGE_PATH } from './rules';

/** The two Markdown parts of a page: the authors' and the community's. */
export type PagePart = 'author' | 'community';
export const PAGE_PARTS: readonly PagePart[] = ['author', 'community'];

const PART_PATH: Record<PagePart, string> = { author: AUTHOR_PAGE_PATH, community: COMMUNITY_PAGE_PATH };
const PART_STARTER: Record<PagePart, string> = { author: AUTHOR_STARTER, community: COMMUNITY_STARTER };
const PART_NAME: Record<PagePart, string> = { author: 'author section', community: 'community section' };

/**
 * Editing the author or community section a section at a time, as a wiki does. The editor sends the section it
 * loaded and the commit it loaded it at; the server puts it back into the file *as it was at that
 * commit*, so `commitPage`'s three-way merge sees exactly what this person changed, and edits to other
 * sections since then merge in.
 */

/** The part's Markdown at a commit, or `null` if it has none. */
async function partAt(db: Reader, paperId: string, part: PagePart, oid: string | null): Promise<string | null> {
  if (!oid) return null;
  const commit = await findCommit(db, paperId, oid);
  if (!commit) throw new ApiError(422, 'validation_error', 'the base is not a commit of this page');
  return readText(db, paperId, (await readFiles(db, paperId, commit.tree)).get(PART_PATH[part]));
}

export interface EditorState {
  part: PagePart;
  /** The commit the text was read at, which the edit is sent back with. */
  baseOid: string | null;
  section: number;
  /** The section's heading, or `null` for the whole page. */
  title: string | null;
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
  const markdown = await partAt(database, paperId, part, baseOid);
  if (markdown === null || markdown.trim() === '') {
    return section === 0 ? { part, baseOid, section, title: null, text: PART_STARTER[part], starter: true } : null;
  }
  if (section === 0) return { part, baseOid, section, title: null, text: markdown, starter: false };
  const found = splitSections(markdown).sections[section - 1];
  return found ? { part, baseOid, section, title: found.title, text: found.text, starter: false } : null;
}

/**
 * The section that is now where this one was: the one with its heading, or else at its place. If there is
 * none, the whole page, as section 0.
 */
function sectionNow(base: string | null, section: number, current: string | null): { section: number; text: string } {
  if (current === null) return { section: 0, text: '' };
  if (section === 0) return { section: 0, text: current };
  const title = base === null ? null : splitSections(base).sections[section - 1]?.title;
  const sections = splitSections(current).sections;
  const found = sections.find((s) => s.title === title) ?? sections[section - 1];
  return found ? { section: found.index, text: found.text } : { section: 0, text: current };
}

/** What an edit is called when its summary is left blank: the section's heading, as a wiki does. */
function defaultSummary(part: PagePart, base: string | null, section: number): string {
  if (base === null || base.trim() === '') return `Start the ${PART_NAME[part]}`;
  const title = section > 0 ? splitSections(base).sections[section - 1]?.title : undefined;
  return title ? `Edit “${title}”` : `Edit the ${PART_NAME[part]}`;
}

export interface SectionEdit {
  part: PagePart;
  baseOid: string | null;
  section: number;
  content: string;
  summary: string;
}

/**
 * Commits one section's new text. A conflict is `409 edit_conflict` with, besides every version of the
 * file, `current`: the head and the section as it is there, for the editor to show beside this text.
 */
export async function editSection(
  paperId: string,
  actor: Actor,
  edit: SectionEdit,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const database = options.database ?? getDb();
  const path = PART_PATH[edit.part];
  await checkedDemoSources(edit.content, database);
  const base = await partAt(database, paperId, edit.part, edit.baseOid);
  const whole = replaceSection(base ?? '', edit.section, edit.content);
  if (whole === null) throw new ApiError(422, 'validation_error', 'that section is not on the page');
  try {
    return await commitPage(
      paperId,
      edit.baseOid,
      actor,
      [{ path, content: whole.trim() === '' ? null : whole }],
      edit.summary.trim() || defaultSummary(edit.part, base, edit.section),
      { ...options, database },
    );
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'edit_conflict') throw err;
    const head = await readHead(database, paperId);
    const current = sectionNow(base, edit.section, await partAt(database, paperId, edit.part, head));
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
