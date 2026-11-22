import { eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageRedirects, pages } from '@/db/schema';
import { formatIdentifier, keyProblem, KINDS, pagePath, partsOf, type TopicFile, topicFileSchema } from '@/lib/kinds';
import {
  encodeLabeledLink,
  type LabeledLinkLine,
  LINKS_FILE,
  newLinkId,
  parseLabeledLinks,
  TOPIC_LABEL,
} from '@/lib/labeled-links';
import { topicNameKey, topicSlug } from '@/lib/topics';
import { ApiError } from './api/errors';
import { linksTo, type PageLink } from './page-links';
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
 * Topic pages (`handoffs/pages.md` Phase 5): research ideas that work as Wikipedia's categories do, each with an
 * article the community writes. Anyone verified makes one; there is no seeded list and no bot writes them.
 *
 * - **In a topic**: a page of any kind is in a topic through its own `in-topic` link (`linkPageToTopic`), in its
 *   `community/links.jsonl`, or its owners' `links.jsonl` when one of them adds it. A topic in another topic is a
 *   subtopic there. Membership is direct: nothing rolls up from subtopics. A paper's link also makes it a member of
 *   the topic's scope (`page-members.ts`), for its statistics.
 * - **The topic page** lists its subtopics and its other pages, by name (`topicOverview`), from "what links here".
 * - **Making one** (`createTopic`): from the "New topic" form, or by name from "Add to a topic", which makes the
 *   topic if no topic has that name yet (`topicsNamed`, `similarTopics` check names first, to keep duplicates down).
 * - **Editing** (`editTopic`: name and article), **renaming** (`renameTopic`, a new address with a redirect from the
 *   old) and **merging** (`mergeTopic`, the duplicate folded into the survivor and redirected there) are open to the
 *   community, through the path rules and page protection (`page-protection.ts`), and show in the patrol feed.
 */

/** A topic as its name is: its key and name. */
export interface TopicNames {
  pageId: string;
  key: string;
  name: string;
}

/** Every topic that isn't merged into another, with its name. */
export async function allTopicNames(database: Reader = getDb()): Promise<TopicNames[]> {
  const { rows } = await database.execute<{ id: string; key: string; kind_file: TopicFile | null }>(sql`
    select p.id, p.key, c.kind_file
      from pages p
      left join page_current c on c.page_id = p.id
     where p.kind = 'topic' and p.merged_into is null
  `);
  return rows.map((row) => ({ pageId: row.id, key: row.key, name: row.kind_file?.name ?? row.key }));
}

/** The topics called one of these names, as duplicates are told (`topicNameKey`). */
export async function topicsNamed(
  names: readonly string[],
  options: { except?: string; database?: Reader } = {},
): Promise<TopicNames[]> {
  const wanted = new Set(names.map(topicNameKey).filter(Boolean));
  if (wanted.size === 0) return [];
  return (await allTopicNames(options.database)).filter(
    (topic) => topic.pageId !== options.except && wanted.has(topicNameKey(topic.name)),
  );
}

/** A topic a form offers for a name typed into it. */
export interface TopicMatch {
  identifier: string;
  key: string;
  name: string;
  /** It is the same name: making another topic of it would be a duplicate. */
  exact: boolean;
}

/**
 * Topics whose name is like `q`: the same name first (`exact`), then by trigram similarity and words in common. What
 * the "New topic" and "Add to a topic" forms show as one types.
 */
export async function similarTopics(
  q: string,
  options: { limit?: number; database?: Reader } = {},
): Promise<TopicMatch[]> {
  const { limit = 10, database = getDb() } = options;
  const text = q.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (text.length < 2) return [];
  const { rows } = await database.execute<{ key: string; name: string; sim: number }>(sql`
    select p.key, c.name, similarity(lower(c.name), lower(${text})) as sim
      from pages p
      join page_current c on c.page_id = p.id
     where p.kind = 'topic' and p.merged_into is null and c.name is not null
       and (c.name ilike ${`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}
            or lower(${text}) like '%' || lower(c.name) || '%'
            or similarity(lower(c.name), lower(${text})) > 0.3)
     order by sim desc
     limit 100
  `);
  const exact = new Set((await topicsNamed([text], { database })).map((topic) => topic.key));
  return rows
    .map((row) => ({
      identifier: formatIdentifier({ kind: 'topic', key: row.key }),
      key: row.key,
      name: row.name,
      exact: exact.has(row.key),
      sim: exact.has(row.key) ? 2 : Number(row.sim),
    }))
    .sort((a, b) => b.sim - a.sim || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((match) => ({ identifier: match.identifier, key: match.key, name: match.name, exact: match.exact }));
}

function exists(topic: TopicNames): ApiError {
  const identifier = formatIdentifier({ kind: 'topic', key: topic.key });
  return new ApiError(409, 'topic_exists', `${identifier} is called “${topic.name}” already`, {
    identifier,
    name: topic.name,
  });
}

function encodeTopicFile(file: TopicFile): string {
  return `${JSON.stringify({ name: file.name }, null, 2)}\n`;
}

/** `topic.json` checked as the schema says, or a 422 naming the field. */
function parseTopicFile(input: unknown): TopicFile {
  const parsed = topicFileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ApiError(422, 'validation_error', `${issue.path.join('.') || 'topic'}: ${issue.message}`);
  }
  return parsed.data;
}

export interface NewTopic {
  name: string;
  /** Its address; made from the name when absent. */
  slug?: string;
  /** The article's first words, "What it is", in Markdown. */
  summary?: string;
}

/** The section a topic's article starts with, from the form's "What it is". */
const SUMMARY_PATH = 'community/10-what-it-is.md';

/**
 * Makes a topic: its page, and its `topic.json` (and the article's first section, if given) committed by whoever makes
 * it, so the path rules check it as any edit. Refuses a name another topic has (`topic_exists`), and an address that
 * is taken. Anyone verified may (`rules.ts`).
 */
export async function createTopic(input: NewTopic, actor: Actor, database: Database = getDb()): Promise<PageRow> {
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const name = input.name.replace(/\s+/g, ' ').trim();
  const slug = (input.slug?.trim().toLowerCase() || topicSlug(name)) ?? '';
  if (!slug) throw new ApiError(422, 'validation_error', 'slug: give the topic an address in Latin letters or digits');
  const problem = keyProblem('topic', slug);
  if (problem) throw new ApiError(422, 'validation_error', `slug: topic:${slug} ${problem}`);
  const file = parseTopicFile({ name });
  const [taken] = await topicsNamed([file.name], { database });
  if (taken) throw exists(taken);
  if (await findKeyedPage(database, 'topic', slug)) {
    throw new ApiError(409, 'page_exists', `topic:${slug} is there already; choose another address`, {
      identifier: `topic:${slug}`,
    });
  }
  const changes: FileChange[] = [{ path: KINDS.topic.kindFile, content: encodeTopicFile(file) }];
  const summary = input.summary?.trim();
  if (summary) changes.push({ path: SUMMARY_PATH, content: `# What it is\n\n${summary}\n` });
  const page = await createPage('topic', slug, database);
  try {
    const result = await commitPage(page.id, page.head, actor, changes, `Start ${file.name}`, { database });
    if (result.status !== 'committed') throw new ApiError(409, 'page_busy', 'the page changed meanwhile; try again');
  } catch (err) {
    await database.delete(pages).where(eq(pages.id, page.id));
    throw err;
  }
  await refreshPages({ kind: 'topic', key: slug });
  return page;
}

/** A topic by identifier (`topic:linear-attention`, following renames and merges) or by its name. */
async function findTopic(ref: { topic?: string; name?: string }, database: Database): Promise<PageRow | null> {
  if (ref.topic) {
    const page = await findPage(ref.topic.startsWith('topic:') ? ref.topic : `topic:${ref.topic}`, database);
    if (!page || page.kind !== 'topic') throw new ApiError(404, 'not_found', `no topic is ${ref.topic}`);
    return page;
  }
  const [named] = await topicsNamed([ref.name ?? ''], { database });
  return named ? mustPage(database, named.pageId) : null;
}

export interface PageTopicInput {
  /** The topic by identifier; or else by `name`, which makes it if no topic has that name. */
  topic?: string;
  name?: string;
  note?: string;
}

export interface PageTopicResult {
  topic: PageRow;
  /** The topic was made for this. */
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
 * Puts a page of any kind in a topic, as a Wikipedia page is put in a category: an `in-topic` link from the page in
 * its `community/links.jsonl`, or its owners' `links.jsonl` when one of its owners adds it, so they assert it as
 * owners (DESIGN.md §8). By name, the topic is made if no topic has that name. A topic put in another is a subtopic.
 */
export async function linkPageToTopic(
  page: PageRow,
  input: PageTopicInput,
  actor: Actor,
  database: Database = getDb(),
): Promise<PageTopicResult> {
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const parts = partsOf(page.kind);
  if (parts.length === 0) throw new ApiError(422, 'validation_error', `a ${page.kind} page is put in no topic`);
  let topic = await findTopic(input, database);
  let created = false;
  if (!topic) {
    if (!input.name?.trim()) throw new ApiError(422, 'validation_error', 'name a topic, or give its identifier');
    topic = await createTopic({ name: input.name }, actor, database);
    created = true;
  }
  if (topic.id === page.id) throw new ApiError(422, 'validation_error', 'a topic is not in itself');
  const target = formatIdentifier({ kind: 'topic', key: topic.key });
  const roles = await rolesOf(database, actor, page.id);
  const owners = KINDS[page.kind].owners;
  const part = roles.owner && owners ? owners.dir : parts[parts.length - 1];
  const path = `${part}/${LINKS_FILE}`;
  const head = await readHead(database, page.id);
  // In any part already: nothing to add.
  for (const each of parts) {
    const parsed = parseLabeledLinks(await textAt(database, page.id, head, `${each}/${LINKS_FILE}`), page.kind);
    const links = 'links' in parsed ? parsed.links : [];
    if (links.some((link) => link.label === TOPIC_LABEL && link.target === target)) {
      return { topic, created, status: 'exists' };
    }
  }
  const line: LabeledLinkLine = {
    id: newLinkId(),
    to: target,
    label: TOPIC_LABEL,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  const content = appendLine(await textAt(database, page.id, head, path), encodeLabeledLink(line));
  const name = (await topicName(database, topic)) ?? topic.key;
  const result = await commitPage(page.id, head, actor, [{ path, content }], `Add to the topic ${name}`, {
    database,
  });
  if (result.status !== 'committed') throw new ApiError(409, 'page_busy', 'the page changed meanwhile; try again');
  await refreshPageIds(database, [page.id, topic.id]);
  return { topic, created, status: 'linked' };
}

async function topicName(db: Reader, topic: PageRow): Promise<string | null> {
  const { rows } = await db.execute<{ name: string | null }>(
    sql`select name from page_current where page_id = ${topic.id}`,
  );
  return rows[0]?.name ?? null;
}

/** What a topic page lists besides its article: its subtopics and its other pages, as a Wikipedia category does. */
export interface TopicOverview {
  /** The topics in it, by name. */
  subtopics: PageLink[];
  /** The pages of other kinds in it, by name. */
  pages: PageLink[];
  /** The topics merged into it, by their old slugs. */
  mergedFrom: string[];
  protection: Protection | null;
}

const byName = (a: PageLink, b: PageLink) => (a.page.name ?? '').localeCompare(b.page.name ?? '');

/** A topic's members (the pages whose `in-topic` links name it, under any of its names) and its merges. */
export async function topicOverview(page: PageRow, database: Database = getDb()): Promise<TopicOverview> {
  const [links, protection, merged] = await Promise.all([
    linksTo(page.id, database),
    protectionOf(database, page.id),
    database.select({ key: pages.key }).from(pages).where(eq(pages.mergedInto, page.id)),
  ]);
  const seen = new Set<string>();
  const members = links.filter((link) => {
    const id = link.page.pageId;
    if (link.label !== TOPIC_LABEL || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    subtopics: members.filter((link) => link.page.kind === 'topic').sort(byName),
    pages: members.filter((link) => link.page.kind !== 'topic').sort(byName),
    mergedFrom: merged.map((row) => row.key).sort(),
    protection,
  };
}

/** The overview as the API gives it (`GET /pages/{identifier}/topic`), with identifiers and addresses. */
export function presentTopicOverview(overview: TopicOverview, origin: string) {
  const member = (link: PageLink) => ({
    identifier: link.page.address ? formatIdentifier(link.page.address) : null,
    url: link.page.address ? `${origin}${pagePath(link.page.address)}` : null,
    kind: link.page.kind,
    name: link.page.name,
  });
  return {
    subtopics: overview.subtopics.map(member),
    pages: overview.pages.map(member),
    mergedFrom: overview.mergedFrom.map((key) => formatIdentifier({ kind: 'topic', key })),
    protection: overview.protection
      ? {
          level: overview.protection.level,
          reason: overview.protection.reason,
          expiresAt: overview.protection.expiresAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** What `editTopic` changes; anything left out stays as it is. */
export interface TopicEdit {
  /** The commit the form loaded, so a change made meanwhile is merged rather than lost. */
  base: string | null;
  name?: string;
  /** The whole article (`community/`) as one Markdown text, a `#` heading per section. */
  article?: string;
  summary?: string;
}

/**
 * Edits a topic in one commit: its name (`topic.json`) and its article's sections. Goes through `commitPage`, so the
 * path rules and page protection hold, a push could do the same, and a change made since `base` is merged. The
 * topics it is in are its links, added like any page's.
 */
export async function editTopic(page: PageRow, edit: TopicEdit, actor: Actor, database: Database = getDb()) {
  if (page.kind !== 'topic') throw new ApiError(422, 'validation_error', 'only a topic page is edited here');
  const base = edit.base;
  const commit = base ? await readCommit(database, page.id, base) : null;
  const files = commit ? await readFiles(database, page.id, commit.tree) : new Map<string, string>();
  const changes: FileChange[] = [];

  if (edit.name !== undefined) {
    const file = parseTopicFile({ name: edit.name.replace(/\s+/g, ' ').trim() });
    const [taken] = await topicsNamed([file.name], { except: page.id, database });
    if (taken) throw exists(taken);
    const content = encodeTopicFile(file);
    if (content !== (await readText(database, page.id, files.get(KINDS.topic.kindFile)))) {
      changes.push({ path: KINDS.topic.kindFile, content });
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
  const result = await commitPage(page.id, base, actor, changes, edit.summary?.trim() || 'Edit the topic', {
    database,
  });
  if (result.status === 'committed') await refreshPages({ kind: 'topic', key: page.key });
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

function topicFileOf(files: ReadonlyMap<string, string>): TopicFile | null {
  try {
    const parsed = topicFileSchema.safeParse(JSON.parse(files.get(KINDS.topic.kindFile) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Whoever may edit the topic's `topic.json` (anyone verified) and isn't held back by its protection. */
async function checkMayEditTopic(db: Reader, page: PageRow, actor: Actor): Promise<void> {
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const roles = await rolesOf(db, actor, page.id);
  if (!roles.verified && !roles.admin)
    throw new ApiError(403, 'forbidden', 'confirm an institutional email address first');
  await checkProtection(db, page.id, roles, [KINDS.topic.kindFile]);
}

/** The handle a commit summary names, for the system's commits made on a person's behalf. */
async function handleOf(db: Reader, actor: Actor): Promise<string> {
  if (actor.kind !== 'account') return 'the system';
  const { rows } = await db.execute<{ handle: string }>(sql`select handle from accounts where id = ${actor.accountId}`);
  return rows[0] ? `@${rows[0].handle}` : 'someone';
}

/**
 * Gives a topic a new address: `topic:<slug>` and `/t/<slug>`, with a redirect from the old one (`page_redirects`),
 * so links and bookmarks that name the old slug still find it (`page-members.ts` counts the old name among the
 * page's). The page's metadata commit says who moved it. With `name`, the name changes too, in the same person's
 * commit.
 */
export async function renameTopic(
  page: PageRow,
  input: { slug: string; name?: string },
  actor: Actor,
  database: Database = getDb(),
): Promise<PageRow> {
  if (page.kind !== 'topic') throw new ApiError(422, 'validation_error', 'only a topic is renamed here');
  await checkMayEditTopic(database, page, actor);
  const slug = input.slug.trim().toLowerCase();
  const problem = keyProblem('topic', slug);
  if (problem) throw new ApiError(422, 'validation_error', `slug: topic:${slug} ${problem}`);
  const old = page.key;
  const by = await handleOf(database, actor);
  if (slug !== old) {
    await database.transaction(async (tx) => {
      await lockPage(tx, page.id);
      if (await findKeyedPage(tx, 'topic', slug)) {
        throw new ApiError(409, 'page_exists', `topic:${slug} is there already`, { identifier: `topic:${slug}` });
      }
      await tx.update(pages).set({ key: slug }).where(eq(pages.id, page.id));
      await tx
        .insert(pageRedirects)
        .values({ kind: 'topic', key: old, pageId: page.id })
        .onConflictDoUpdate({ target: [pageRedirects.kind, pageRedirects.key], set: { pageId: page.id } });
      const content = `${JSON.stringify({ layout: LAYOUT_VERSION, kind: 'topic', key: slug }, null, 2)}\n`;
      await commitPage(
        page.id,
        await readHead(tx, page.id),
        { kind: 'system' },
        [{ path: METADATA_PATH, content }],
        `Moved from topic:${old} to topic:${slug} by ${by}`,
        { database: tx as unknown as Database },
      );
    });
  }
  const moved = { ...page, key: slug };
  const name = input.name?.replace(/\s+/g, ' ').trim();
  if (name) {
    const { head, files } = await textsAt(database, page.id);
    if (topicFileOf(files)?.name !== name) {
      await editTopic(moved, { base: head, name, summary: `Rename to ${name}` }, actor, database);
    }
  }
  await refreshPages({ kind: 'topic', key: old });
  await refreshPages({ kind: 'topic', key: slug });
  return moved;
}

/**
 * Merges a duplicate topic into another: the survivor gains the duplicate's article's sections (each saying where it
 * came from) and its links, in one commit by whoever merges; the duplicate's page is marked merged
 * (`pages.merged_into`), so its address, its identifier and its old slugs lead to the survivor, pages in it are in the
 * survivor (`linksTo` and `page-members.ts` follow merges), and nobody commits to it again. Its history stays.
 */
export async function mergeTopic(
  duplicate: PageRow,
  survivor: PageRow,
  actor: Actor,
  options: { summary?: string; database?: Database } = {},
): Promise<{ status: 'committed' | 'unchanged'; oid: string | null }> {
  const database = options.database ?? getDb();
  if (duplicate.kind !== 'topic' || survivor.kind !== 'topic') {
    throw new ApiError(422, 'validation_error', 'only a topic is merged into a topic');
  }
  if (duplicate.id === survivor.id) throw new ApiError(422, 'validation_error', 'a topic cannot be merged into itself');
  await checkMayEditTopic(database, duplicate, actor);
  await checkMayEditTopic(database, survivor, actor);
  const result = await database.transaction(async (tx) => {
    const rows = await tx
      .select({ id: pages.id, mergedInto: pages.mergedInto })
      .from(pages)
      .where(inArray(pages.id, [duplicate.id, survivor.id]))
      .for('update');
    if (rows.length !== 2) throw new ApiError(404, 'not_found', 'no such topic');
    if (rows.some((row) => row.mergedInto))
      throw new ApiError(409, 'page_merged', 'one of these topics was merged already');
    await lockPage(tx, duplicate.id);
    const theirs = await textsAt(tx, duplicate.id);
    const ours = await textsAt(tx, survivor.id);
    const changes = foldTopics(ours.files, theirs.files, duplicate.key, survivor.key);
    const commit = await commitPage(
      survivor.id,
      ours.head,
      actor,
      changes,
      options.summary?.trim() || `Merge topic:${duplicate.key} into this topic`,
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
  await refreshPages({ kind: 'topic', key: duplicate.key });
  await refreshPages({ kind: 'topic', key: survivor.key });
  return result;
}

/** The changes that fold a duplicate topic's files into the survivor's (`mergeTopic`). */
export function foldTopics(
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
          ? `<p><em>From topic:${from}, merged into this page.</em></p>`
          : `*From topic:${from}, merged into this page.*`
      }\n`,
      format: section.name.format,
    }));
    changes.push(...planSections(kept, 'community', kept.length, kept.length, parts));
  }

  const path = `community/${LINKS_FILE}`;
  const ourLinks = parseLabeledLinks(survivor.get(path) ?? '', 'topic');
  const theirLinks = parseLabeledLinks(duplicate.get(path) ?? '', 'topic');
  if ('links' in ourLinks && 'links' in theirLinks && theirLinks.links.length > 0) {
    const seen = new Set(ourLinks.links.map((link) => `${link.label} ${link.target}`));
    const ids = new Set(ourLinks.links.map((link) => link.id));
    const lines = ourLinks.links.map((link) => encodeLabeledLink(link));
    for (const link of theirLinks.links) {
      const key = `${link.label} ${link.target}`;
      if (seen.has(key) || link.target === `topic:${into}` || link.target === `topic:${from}`) continue;
      seen.add(key);
      lines.push(encodeLabeledLink({ ...link, id: ids.has(link.id) ? newLinkId() : link.id }));
      ids.add(link.id);
    }
    if (lines.length > ourLinks.links.length) changes.push({ path, content: `${lines.join('\n')}\n` });
  }
  return changes;
}
