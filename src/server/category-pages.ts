import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageRedirects, pages } from '@/db/schema';
import {
  formatIdentifier,
  keyProblem,
  KINDS,
  pagePath,
  partsOf,
  type CategoryFile,
  categoryFileSchema,
} from '@/lib/kinds';
import {
  encodeLabeledLink,
  type LabeledLinkLine,
  LINKS_FILE,
  newLinkId,
  parseLabeledLinks,
  CATEGORY_LABEL,
} from '@/lib/labeled-links';
import { categoryNameKey, categorySlug } from '@/lib/categories';
import { ApiError } from './api/errors';
import { indexPageLinks, linksTo, type PageLink } from './page-links';
import { indexMembers } from './page-members';
import { checkProtection, type Protection, protectionOf } from './page-protection';
import { rolesOf } from './pages/check';
import { type Actor, commitPage, createPage, type FileChange } from './pages/commit';
import { findKeyedPage, findPage, mustPage, type PageRow } from './pages/kinds';
import { planSections, readSections, type SectionFile, sectionPaths, sectionTitle } from './pages/sections';
import { splitSections } from './pages/markdown';
import { lockPage } from './pages/projections';
import { refreshPageIds, refreshPages } from './pages/refresh';
import { readCommit, readFiles, readHead, readText, type Reader } from './pages/repo';
import { LAYOUT_VERSION, METADATA_PATH, sectionName } from './pages/rules';

/**
 * Category pages (`handoffs/pages.md` Phase 5): research ideas that work as Wikipedia's categories do, each with an
 * article the community writes. Anyone verified makes one; there is no seeded list and no bot writes them.
 *
 * - **In a category**: a page of any kind is in a category through its own `in-category` link (`linkPageToCategory`), in its
 *   `community/links.jsonl`, or its owners' `links.jsonl` when one of them adds it. A category in another category is a
 *   subcategory there. Membership is direct: nothing rolls up from subcategories. A paper's link also makes it a member of
 *   the category's scope (`page-members.ts`), for its statistics.
 * - **The category page** lists its subcategories and its other pages, by name (`categoryOverview`), from "what links here".
 * - **Making one** (`createCategory`): from the "New category" form, or by name from "Add to a category", which makes the
 *   category if no category has that name yet (`categoriesNamed`, `similarCategories` check names first, to keep duplicates down).
 * - **Editing** (`editCategory`: name and article), **renaming** (`renameCategory`, a new address with a redirect from the
 *   old) and **merging** (`mergeCategory`, the duplicate folded into the survivor and redirected there) are open to the
 *   community, through the path rules and page protection (`page-protection.ts`), and show in the patrol feed.
 */

/** A category as its name is: its key and name. */
export interface CategoryNames {
  pageId: string;
  key: string;
  name: string;
}

/** Every category that isn't merged into another, with its name. */
export async function allCategoryNames(database: Reader = getDb()): Promise<CategoryNames[]> {
  const { rows } = await database.execute<{ id: string; key: string; kind_file: CategoryFile | null }>(sql`
    select p.id, p.key, c.kind_file
      from pages p
      left join page_current c on c.page_id = p.id
     where p.kind = 'category' and p.merged_into is null
  `);
  return rows.map((row) => ({ pageId: row.id, key: row.key, name: row.kind_file?.name ?? row.key }));
}

/** The categories called one of these names, as duplicates are told (`categoryNameKey`). */
export async function categoriesNamed(
  names: readonly string[],
  options: { except?: string; database?: Reader } = {},
): Promise<CategoryNames[]> {
  const wanted = new Set(names.map(categoryNameKey).filter(Boolean));
  if (wanted.size === 0) return [];
  return (await allCategoryNames(options.database)).filter(
    (category) => category.pageId !== options.except && wanted.has(categoryNameKey(category.name)),
  );
}

/** A category a form offers for a name typed into it. */
export interface CategoryMatch {
  identifier: string;
  key: string;
  name: string;
  /** It is the same name: making another category of it would be a duplicate. */
  exact: boolean;
}

/**
 * Categories whose name is like `q`, misspelled or not: the same name first (`exact`), then by trigram similarity, of the whole name or its closest words (`word_similarity`). What
 * the "New category" and "Add to a category" forms show as one types.
 */
export async function similarCategories(
  q: string,
  options: { limit?: number; database?: Reader } = {},
): Promise<CategoryMatch[]> {
  const { limit = 10, database = getDb() } = options;
  const text = q.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (text.length < 2) return [];
  const { rows } = await database.execute<{ key: string; name: string; sim: number }>(sql`
    select p.key, c.name,
           greatest(similarity(lower(c.name), lower(${text})), word_similarity(lower(${text}), lower(c.name))) as sim
      from pages p
      join page_current c on c.page_id = p.id
     where p.kind = 'category' and p.merged_into is null and c.name is not null
       and (c.name ilike ${`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}
            or lower(${text}) like '%' || lower(c.name) || '%'
            or similarity(lower(c.name), lower(${text})) > 0.3
            -- Misspelled, or part of the name misspelled: "langauge" finds "Large language models".
            or word_similarity(lower(${text}), lower(c.name)) > 0.45)
     order by sim desc
     limit 100
  `);
  const exact = new Set((await categoriesNamed([text], { database })).map((category) => category.key));
  return rows
    .map((row) => ({
      identifier: formatIdentifier({ kind: 'category', key: row.key }),
      key: row.key,
      name: row.name,
      exact: exact.has(row.key),
      sim: exact.has(row.key) ? 2 : Number(row.sim),
    }))
    .sort((a, b) => b.sim - a.sim || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((match) => ({ identifier: match.identifier, key: match.key, name: match.name, exact: match.exact }));
}

function exists(category: CategoryNames): ApiError {
  const identifier = formatIdentifier({ kind: 'category', key: category.key });
  return new ApiError(409, 'category_exists', `${identifier} is called “${category.name}” already`, {
    identifier,
    name: category.name,
  });
}

function encodeCategoryFile(file: CategoryFile): string {
  return `${JSON.stringify({ name: file.name }, null, 2)}\n`;
}

/** `category.json` checked as the schema says, or a 422 naming the field. */
function parseCategoryFile(input: unknown): CategoryFile {
  const parsed = categoryFileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(422, 'validation_error', `${issue.path.join('.') || 'category'}: ${issue.message}`);
  }
  return parsed.data;
}

export interface NewCategory {
  name: string;
  /** Its address; made from the name when absent. */
  slug?: string;
  /** The article's first words, "What it is", in Markdown. */
  summary?: string;
}

/** The section a category's article starts with, from the form's "What it is". */
const SUMMARY_PATH = 'community/10-what-it-is.md';

/**
 * Makes a category: its page, and its `category.json` (and the article's first section, if given) committed by whoever makes
 * it, so the path rules check it as any edit. Refuses a name another category has (`category_exists`), and an address that
 * is taken. Anyone verified may (`rules.ts`).
 */
export async function createCategory(input: NewCategory, actor: Actor, database: Database = getDb()): Promise<PageRow> {
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const name = input.name.replace(/\s+/g, ' ').trim();
  const slug = (input.slug?.trim().toLowerCase() || categorySlug(name)) ?? '';
  if (!slug)
    throw new ApiError(422, 'validation_error', 'slug: give the category an address in Latin letters or digits');
  const problem = keyProblem('category', slug);
  if (problem) throw new ApiError(422, 'validation_error', `slug: category:${slug} ${problem}`);
  const file = parseCategoryFile({ name });
  const [taken] = await categoriesNamed([file.name], { database });
  if (taken) throw exists(taken);
  if (await findKeyedPage(database, 'category', slug)) {
    throw new ApiError(409, 'page_exists', `category:${slug} is there already; choose another address`, {
      identifier: `category:${slug}`,
    });
  }
  const changes: FileChange[] = [{ path: KINDS.category.kindFile, content: encodeCategoryFile(file) }];
  const summary = input.summary?.trim();
  if (summary) changes.push({ path: SUMMARY_PATH, content: `# What it is\n\n${summary}\n` });
  const page = await createPage('category', slug, database);
  try {
    const result = await commitPage(page.id, page.head, actor, changes, `Start ${file.name}`, { database });
    if (result.status !== 'committed') throw new ApiError(409, 'page_busy', 'the page changed meanwhile; try again');
  } catch (err) {
    await database.delete(pages).where(eq(pages.id, page.id));
    throw err;
  }
  await refreshPages({ kind: 'category', key: slug });
  return page;
}

/** A category by identifier (`category:linear-attention`, following renames and merges) or by its name. */
async function findCategory(ref: { category?: string; name?: string }, database: Database): Promise<PageRow | null> {
  if (ref.category) {
    const page = await findPage(
      ref.category.startsWith('category:') ? ref.category : `category:${ref.category}`,
      database,
    );
    if (!page || page.kind !== 'category') throw new ApiError(404, 'not_found', `no category is ${ref.category}`);
    return page;
  }
  const [named] = await categoriesNamed([ref.name ?? ''], { database });
  return named ? mustPage(database, named.pageId) : null;
}

export interface PageCategoryInput {
  /** The category by identifier; or else by `name`, which makes it if no category has that name. */
  category?: string;
  name?: string;
  note?: string;
}

export interface PageCategoryResult {
  category: PageRow;
  /** The category was made for this. */
  created: boolean;
  /** `exists`: the page was in it already. */
  status: 'linked' | 'exists';
}

/** A file's text at a page's head, or `''`. */
async function textAt(db: Reader, pageId: string, head: string | null, path: string): Promise<string> {
  if (!head) return '';
  const commit = await readCommit(db, pageId, head);
  return (await readText(db, pageId, (await readFiles(db, pageId, commit.tree)).get(path))) ?? '';
}

/** A JSONL file with one more line. */
function appendLine(text: string, line: string): string {
  const body = text.replace(/\s+$/, '');
  return `${body ? `${body}\n` : ''}${line}\n`;
}

/**
 * Puts a page of any kind in a category, as a Wikipedia page is put in a category: an `in-category` link from the page in
 * its `community/links.jsonl`, or its owners' `links.jsonl` when one of its owners adds it, so they assert it as
 * owners (DESIGN.md §8). By name, the category is made if no category has that name. A category put in another is a subcategory.
 */
export async function linkPageToCategory(
  page: PageRow,
  input: PageCategoryInput,
  actor: Actor,
  database: Database = getDb(),
): Promise<PageCategoryResult> {
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const parts = partsOf(page.kind);
  if (parts.length === 0) throw new ApiError(422, 'validation_error', `a ${page.kind} page is put in no category`);
  let category = await findCategory(input, database);
  let created = false;
  if (!category) {
    if (!input.name?.trim()) throw new ApiError(422, 'validation_error', 'name a category, or give its identifier');
    category = await createCategory({ name: input.name }, actor, database);
    created = true;
  }
  if (category.id === page.id) throw new ApiError(422, 'validation_error', 'a category is not in itself');
  const target = formatIdentifier({ kind: 'category', key: category.key });
  const roles = await rolesOf(database, actor, page.id);
  const owners = KINDS[page.kind].owners;
  const part = roles.owner && owners ? owners.dir : parts[parts.length - 1];
  const path = `${part}/${LINKS_FILE}`;
  const head = await readHead(database, page.id);
  // In any part already: nothing to add.
  for (const each of parts) {
    const parsed = parseLabeledLinks(await textAt(database, page.id, head, `${each}/${LINKS_FILE}`), page.kind);
    const links = 'links' in parsed ? parsed.links : [];
    if (links.some((link) => link.label === CATEGORY_LABEL && link.target === target)) {
      return { category, created, status: 'exists' };
    }
  }
  const line: LabeledLinkLine = {
    id: newLinkId(),
    to: target,
    label: CATEGORY_LABEL,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  const content = appendLine(await textAt(database, page.id, head, path), encodeLabeledLink(line));
  const name = (await categoryName(database, category)) ?? category.key;
  const result = await commitPage(page.id, head, actor, [{ path, content }], `Add to the category ${name}`, {
    database,
  });
  if (result.status !== 'committed') throw new ApiError(409, 'page_busy', 'the page changed meanwhile; try again');
  // Indexed now rather than by the worker a moment later, so both pages show it on their next render; the worker
  // indexing the same commit again changes nothing.
  await indexPageLinks(database, page.id, result.oid);
  await refreshPageIds(database, [page.id, category.id]);
  return { category, created, status: 'linked' };
}

async function categoryName(db: Reader, category: PageRow): Promise<string | null> {
  const { rows } = await db.execute<{ name: string | null }>(
    sql`select name from page_current where page_id = ${category.id}`,
  );
  return rows[0]?.name ?? null;
}

/** What a category page lists besides its article: its subcategories and its other pages, as a Wikipedia category does. */
export interface CategoryOverview {
  /** The categories in it, by name. */
  subcategories: PageLink[];
  /** The pages of other kinds in it, by name. */
  pages: PageLink[];
  /** The categories merged into it, by their old slugs. */
  mergedFrom: string[];
  protection: Protection | null;
}

const byName = (a: PageLink, b: PageLink) => (a.page.name ?? '').localeCompare(b.page.name ?? '');

/** A category's members (the pages whose `in-category` links name it, under any of its names) and its merges. */
export async function categoryOverview(page: PageRow, database: Database = getDb()): Promise<CategoryOverview> {
  const [links, protection, merged] = await Promise.all([
    linksTo(page.id, database),
    protectionOf(database, page.id),
    database.select({ key: pages.key }).from(pages).where(eq(pages.mergedInto, page.id)),
  ]);
  const seen = new Set<string>();
  const members = links.filter((link) => {
    const id = link.page.pageId;
    if (link.label !== CATEGORY_LABEL || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    subcategories: members.filter((link) => link.page.kind === 'category').sort(byName),
    pages: members.filter((link) => link.page.kind !== 'category').sort(byName),
    mergedFrom: merged.map((row) => row.key).sort(),
    protection,
  };
}

/** The overview as the API gives it (`GET /pages/{identifier}/category`), with identifiers and addresses. */
export function presentCategoryOverview(overview: CategoryOverview, origin: string) {
  const member = (link: PageLink) => ({
    identifier: link.page.address ? formatIdentifier(link.page.address) : null,
    url: link.page.address ? `${origin}${pagePath(link.page.address)}` : null,
    kind: link.page.kind,
    name: link.page.name,
  });
  return {
    subcategories: overview.subcategories.map(member),
    pages: overview.pages.map(member),
    mergedFrom: overview.mergedFrom.map((key) => formatIdentifier({ kind: 'category', key })),
    protection: overview.protection
      ? {
          level: overview.protection.level,
          reason: overview.protection.reason,
          expiresAt: overview.protection.expiresAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** What `editCategory` changes; anything left out stays as it is. */
export interface CategoryEdit {
  /** The commit the form loaded, so a change made meanwhile is merged rather than lost. */
  base: string | null;
  name?: string;
  /** The whole article (`community/`) as one Markdown text, a `#` heading per section. */
  article?: string;
  summary?: string;
}

/**
 * Edits a category in one commit: its name (`category.json`) and its article's sections. Goes through `commitPage`, so the
 * path rules and page protection hold, a push could do the same, and a change made since `base` is merged. The
 * categories it is in are its links, added like any page's.
 */
export async function editCategory(page: PageRow, edit: CategoryEdit, actor: Actor, database: Database = getDb()) {
  if (page.kind !== 'category') throw new ApiError(422, 'validation_error', 'only a category page is edited here');
  const base = edit.base;
  const commit = base ? await readCommit(database, page.id, base) : null;
  const files = commit ? await readFiles(database, page.id, commit.tree) : new Map<string, string>();
  const changes: FileChange[] = [];

  if (edit.name !== undefined) {
    const file = parseCategoryFile({ name: edit.name.replace(/\s+/g, ' ').trim() });
    const [taken] = await categoriesNamed([file.name], { except: page.id, database });
    if (taken) throw exists(taken);
    const content = encodeCategoryFile(file);
    if (content !== (await readText(database, page.id, files.get(KINDS.category.kindFile)))) {
      changes.push({ path: KINDS.category.kindFile, content });
    }
  }

  if (edit.article !== undefined) {
    const sections = await readSections(database, page.id, files, 'community');
    // A heading with nothing under it (the editor's template for an empty article) is no section yet.
    const parts = splitSections(edit.article.replace(/\r\n/g, '\n')).filter(
      (part) => part.text.replace(/^#[^\n]*\n?/, '').trim() !== '',
    );
    changes.push(...planSections(sections, 'community', 0, sections.length, parts));
  }

  if (changes.length === 0) return { status: 'unchanged' as const, oid: base };
  const result = await commitPage(page.id, base, actor, changes, edit.summary?.trim() || 'Edit the category', {
    database,
  });
  if (result.status === 'committed') await refreshPages({ kind: 'category', key: page.key });
  return result;
}

/** The text of every file at a page's head, and its head. */
async function textsAt(db: Reader, pageId: string) {
  const head = await readHead(db, pageId);
  const files = new Map<string, string>();
  if (!head) return { head, files };
  const commit = await readCommit(db, pageId, head);
  for (const [path, blob] of await readFiles(db, pageId, commit.tree)) {
    const text = await readText(db, pageId, blob);
    if (text !== null) files.set(path, text);
  }
  return { head, files };
}

function categoryFileOf(files: ReadonlyMap<string, string>): CategoryFile | null {
  try {
    const parsed = categoryFileSchema.safeParse(JSON.parse(files.get(KINDS.category.kindFile) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Whoever may edit the category's `category.json` (anyone verified) and isn't held back by its protection. */
async function checkMayEditCategory(db: Reader, page: PageRow, actor: Actor): Promise<void> {
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const roles = await rolesOf(db, actor, page.id);
  if (!roles.verified && !roles.admin)
    throw new ApiError(403, 'forbidden', 'confirm an institutional email address first');
  await checkProtection(db, page.id, roles, [KINDS.category.kindFile]);
}

/** The handle a commit summary names, for the system's commits made on a person's behalf. */
async function handleOf(db: Reader, actor: Actor): Promise<string> {
  if (actor.kind !== 'account') return 'the system';
  const { rows } = await db.execute<{ handle: string }>(sql`select handle from accounts where id = ${actor.accountId}`);
  return rows[0] ? `@${rows[0].handle}` : 'someone';
}

/**
 * Gives a category a new address: `category:<slug>` and `/c/<slug>`, with a redirect from the old one (`page_redirects`),
 * so links and bookmarks that name the old slug still find it (`page-members.ts` counts the old name among the
 * page's). The page's metadata commit says who moved it. With `name`, the name changes too, in the same person's
 * commit.
 */
export async function renameCategory(
  page: PageRow,
  input: { slug: string; name?: string },
  actor: Actor,
  database: Database = getDb(),
): Promise<PageRow> {
  if (page.kind !== 'category') throw new ApiError(422, 'validation_error', 'only a category is renamed here');
  await checkMayEditCategory(database, page, actor);
  const slug = input.slug.trim().toLowerCase();
  const problem = keyProblem('category', slug);
  if (problem) throw new ApiError(422, 'validation_error', `slug: category:${slug} ${problem}`);
  const old = page.key;
  const by = await handleOf(database, actor);
  if (slug !== old) {
    await database.transaction(async (tx) => {
      await lockPage(tx, page.id);
      if (await findKeyedPage(tx, 'category', slug)) {
        throw new ApiError(409, 'page_exists', `category:${slug} is there already`, { identifier: `category:${slug}` });
      }
      await tx.update(pages).set({ key: slug }).where(eq(pages.id, page.id));
      await tx
        .insert(pageRedirects)
        .values({ kind: 'category', key: old, pageId: page.id })
        .onConflictDoUpdate({ target: [pageRedirects.kind, pageRedirects.key], set: { pageId: page.id } });
      const content = `${JSON.stringify({ layout: LAYOUT_VERSION, kind: 'category', key: slug }, null, 2)}\n`;
      await commitPage(
        page.id,
        await readHead(tx, page.id),
        { kind: 'system' },
        [{ path: METADATA_PATH, content }],
        `Moved from category:${old} to category:${slug} by ${by}`,
        { database: tx as unknown as Database },
      );
    });
  }
  const moved = { ...page, key: slug };
  const name = input.name?.replace(/\s+/g, ' ').trim();
  if (name) {
    const { head, files } = await textsAt(database, page.id);
    if (categoryFileOf(files)?.name !== name) {
      await editCategory(moved, { base: head, name, summary: `Rename to ${name}` }, actor, database);
    }
  }
  await refreshPages({ kind: 'category', key: old });
  await refreshPages({ kind: 'category', key: slug });
  return moved;
}

/**
 * Merges a duplicate category into another: the survivor gains the duplicate's article's sections (each saying where it
 * came from) and its links, in one commit by whoever merges; the duplicate's page is marked merged
 * (`pages.merged_into`), so its address, its identifier and its old slugs lead to the survivor, pages in it are in the
 * survivor (`linksTo` and `page-members.ts` follow merges), and nobody commits to it again. Its history stays.
 */
export async function mergeCategory(
  duplicate: PageRow,
  survivor: PageRow,
  actor: Actor,
  options: { summary?: string; database?: Database } = {},
): Promise<{ status: 'committed' | 'unchanged'; oid: string | null }> {
  const database = options.database ?? getDb();
  if (duplicate.kind !== 'category' || survivor.kind !== 'category') {
    throw new ApiError(422, 'validation_error', 'only a category is merged into a category');
  }
  if (duplicate.id === survivor.id)
    throw new ApiError(422, 'validation_error', 'a category cannot be merged into itself');
  await checkMayEditCategory(database, duplicate, actor);
  await checkMayEditCategory(database, survivor, actor);
  const result = await database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: pages.id, mergedInto: pages.mergedInto })
      .from(pages)
      .where(inArray(pages.id, [duplicate.id, survivor.id]))
      .for('update');
    if (rows.length !== 2) throw new ApiError(404, 'not_found', 'no such category');
    if (rows.some((row) => row.mergedInto))
      throw new ApiError(409, 'page_merged', 'one of these categories was merged already');
    await lockPage(tx, duplicate.id);
    const theirs = await textsAt(tx, duplicate.id);
    const ours = await textsAt(tx, survivor.id);
    const changes = foldCategories(ours.files, theirs.files, duplicate.key, survivor.key);
    const commit = await commitPage(
      survivor.id,
      ours.head,
      actor,
      changes,
      options.summary?.trim() || `Merge category:${duplicate.key} into this category`,
      { database: tx as unknown as Database },
    );
    await tx.update(pages).set({ mergedInto: survivor.id }).where(eq(pages.id, duplicate.id));
    // Its old slugs, and anything merged into it before, lead to the survivor now.
    await tx.update(pageRedirects).set({ pageId: survivor.id }).where(eq(pageRedirects.pageId, duplicate.id));
    await tx.update(pages).set({ mergedInto: survivor.id }).where(eq(pages.mergedInto, duplicate.id));
    // It is no scope any more: the survivor answers to its name (`page-members.ts`). Its own event says so too, if
    // the consumer reads one later.
    await tx.execute(sql`delete from page_scope_names where page_id = ${duplicate.id}`);
    await tx.execute(sql`delete from page_parents where page_id = ${duplicate.id}`);
    await tx.execute(sql`delete from page_members where scope_page_id = ${duplicate.id}`);
    return { status: commit.status, oid: commit.oid };
  });
  // The survivor's names now include the duplicate's: its members follow at once, even when the fold changed nothing
  // (the consumer would catch up on the survivor's next event).
  const head = await readHead(database, survivor.id);
  if (head) await indexMembers(database, survivor.id, head);
  await refreshPages({ kind: 'category', key: duplicate.key });
  await refreshPages({ kind: 'category', key: survivor.key });
  return result;
}

/** The changes that fold a duplicate category's files into the survivor's (`mergeCategory`). */
export function foldCategories(
  survivor: ReadonlyMap<string, string>,
  duplicate: ReadonlyMap<string, string>,
  from: string,
  into: string,
): FileChange[] {
  const changes: FileChange[] = [];

  const sectionsOf = (files: ReadonlyMap<string, string>): SectionFile[] =>
    sectionPaths(files.keys(), 'community').map((path) => ({
      path,
      name: sectionName(path, 'community')!,
      text: files.get(path)!,
    }));
  const kept = sectionsOf(survivor);
  const added = sectionsOf(duplicate).filter(
    (section) => section.text.trim() !== '' && !kept.some((s) => s.text.includes(section.text.trim())),
  );
  if (added.length > 0) {
    const parts = added.map((section) => ({
      title: sectionTitle(section),
      text: `${section.text.trimEnd()}\n\n${
        section.name.format === 'html'
          ? `<p><em>From category:${from}, merged into this page.</em></p>`
          : `*From category:${from}, merged into this page.*`
      }\n`,
      format: section.name.format,
    }));
    changes.push(...planSections(kept, 'community', kept.length, kept.length, parts));
  }

  const path = `community/${LINKS_FILE}`;
  const ourLinks = parseLabeledLinks(survivor.get(path) ?? '', 'category');
  const theirLinks = parseLabeledLinks(duplicate.get(path) ?? '', 'category');
  if ('links' in ourLinks && 'links' in theirLinks && theirLinks.links.length > 0) {
    const seen = new Set(ourLinks.links.map((link) => `${link.label} ${link.target}`));
    const ids = new Set(ourLinks.links.map((link) => link.id));
    const lines = ourLinks.links.map((link) => encodeLabeledLink(link));
    for (const link of theirLinks.links) {
      const key = `${link.label} ${link.target}`;
      if (seen.has(key) || link.target === `category:${into}` || link.target === `category:${from}`) continue;
      seen.add(key);
      lines.push(encodeLabeledLink({ ...link, id: ids.has(link.id) ? newLinkId() : link.id }));
      ids.add(link.id);
    }
    if (lines.length > ourLinks.links.length) changes.push({ path, content: `${lines.join('\n')}\n` });
  }
  return changes;
}
