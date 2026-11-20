import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { pageMembers, pageRedirects, pages, topicSuggestions } from '@/db/schema';
import { formatIdentifier, keyedPagePath, keyProblem, KINDS, type TopicFile, topicFileSchema } from '@/lib/kinds';
import {
  encodeLabeledLink,
  type LabeledLinkLine,
  LINKS_FILE,
  newLinkId,
  parseLabeledLinks,
  TOPIC_LABELS,
} from '@/lib/labeled-links';
import type { PageSummary } from '@/lib/plugins/protocol';
import { topicNameKey, topicSlug, type TopicLinkLabel } from '@/lib/topics';
import { ApiError } from './api/errors';
import { linksFrom, linksTo } from './page-links';
import { indexMembers, type OverlapPage, scopeOverlap } from './page-members';
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
import { pageSummaries } from './plugins/pages';

/**
 * Topic pages (`handoffs/pages.md` Phase 5): research ideas at the size of a Wikipedia article, which anyone verified
 * makes and the community writes, like a Wikipedia article: there is no seeded list and no bot writes them.
 *
 * - **Making one** (`createTopic`): from the "New topic" form, or from "Add a topic" on a paper (`linkPaperToTopic`),
 *   which links the paper and makes the topic if no topic of that name or alias exists yet. Names and aliases are
 *   checked first (`topicsNamed`, `similarTopics`), to keep duplicates down.
 * - **A paper in a topic** is a labeled link from the paper (`in-topic`, `introduces-topic`), in its `community/` or,
 *   from one of its confirmed authors, its `owners/` links; membership (`page-members.ts`) follows from it, rolled up
 *   from narrower topics through `broader`.
 * - **Editing** (`editTopic`: name, aliases, broader topics, the article's sections, related topics), **renaming**
 *   (`renameTopic`, a new address with a redirect from the old) and **merging** (`mergeTopic`, the duplicate folded
 *   into the survivor and redirected there) are open to the community, through the path rules and page protection
 *   (`page-protection.ts`), and show in the patrol feed (`changes.ts`).
 */

/** A topic as its names are: its key, name and aliases. */
export interface TopicNames {
  pageId: string;
  key: string;
  name: string;
  aliases: string[];
}

/** Every topic that isn't merged into another, with its names. */
export async function allTopicNames(database: Reader = getDb()): Promise<TopicNames[]> {
  const { rows } = await database.execute<{ id: string; key: string; kind_file: TopicFile | null }>(sql`
    select p.id, p.key, c.kind_file
      from pages p
      left join page_current c on c.page_id = p.id
     where p.kind = 'topic' and p.merged_into is null
  `);
  return rows.map((row) => ({
    pageId: row.id,
    key: row.key,
    name: row.kind_file?.name ?? row.key,
    aliases: row.kind_file?.aliases ?? [],
  }));
}

/** A topic that answers to a name, and which of its names it was. */
export interface NamedTopic extends TopicNames {
  matched: string;
}

/** The topics one of whose names (name or alias) is one of these, as duplicates are told (`topicNameKey`). */
export async function topicsNamed(
  names: readonly string[],
  options: { except?: string; database?: Reader } = {},
): Promise<NamedTopic[]> {
  const wanted = new Set(names.map(topicNameKey).filter(Boolean));
  if (wanted.size === 0) return [];
  const out: NamedTopic[] = [];
  for (const topic of await allTopicNames(options.database)) {
    if (topic.pageId === options.except) continue;
    const matched = [topic.name, ...topic.aliases].find((name) => wanted.has(topicNameKey(name)));
    if (matched) out.push({ ...topic, matched });
  }
  return out;
}

/** A topic a form offers for a name typed into it. */
export interface TopicMatch {
  identifier: string;
  key: string;
  name: string;
  aliases: string[];
  /** The name or alias that matched. */
  matched: string;
  /** It is the same name: making another topic of it would be a duplicate. */
  exact: boolean;
}

/**
 * Topics whose name or an alias is like `q`: the same name first (`exact`), then by trigram similarity and words in
 * common. What the "New topic" and "Add a topic" forms show as one types.
 */
export async function similarTopics(
  q: string,
  options: { limit?: number; database?: Reader } = {},
): Promise<TopicMatch[]> {
  const { limit = 10, database = getDb() } = options;
  const text = q.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (text.length < 2) return [];
  const { rows } = await database.execute<{
    key: string;
    name: string;
    aliases: string[];
    alias: string;
    sim: number;
  }>(sql`
    select p.key, coalesce(c.kind_file ->> 'name', p.key) as name,
           array(select jsonb_array_elements_text(coalesce(c.kind_file -> 'aliases', '[]'::jsonb))) as aliases,
           n.alias, similarity(lower(n.alias), lower(${text})) as sim
      from pages p
      join page_current c on c.page_id = p.id
      cross join lateral (
        select c.kind_file ->> 'name' as alias
        union
        select jsonb_array_elements_text(coalesce(c.kind_file -> 'aliases', '[]'::jsonb))
      ) n
     where p.kind = 'topic' and p.merged_into is null and n.alias is not null
       and (n.alias ilike ${`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}
            or lower(${text}) like '%' || lower(n.alias) || '%'
            or similarity(lower(n.alias), lower(${text})) > 0.3)
     order by sim desc
     limit 100
  `);
  const exact = await topicsNamed([text], { database });
  const byKey = new Map<string, TopicMatch & { sim: number }>();
  for (const topic of exact) {
    byKey.set(topic.key, { ...presentNames(topic), matched: topic.matched, exact: true, sim: 2 });
  }
  for (const row of rows) {
    if (byKey.has(row.key)) continue;
    byKey.set(row.key, {
      ...presentNames({ key: row.key, name: row.name, aliases: row.aliases }),
      matched: row.alias,
      exact: false,
      sim: Number(row.sim),
    });
  }
  return [...byKey.values()]
    .sort((a, b) => b.sim - a.sim || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((match) => ({
      identifier: match.identifier,
      key: match.key,
      name: match.name,
      aliases: match.aliases,
      matched: match.matched,
      exact: match.exact,
    }));
}

function presentNames(topic: { key: string; name: string; aliases: string[] }) {
  return {
    identifier: formatIdentifier({ kind: 'topic', key: topic.key }),
    key: topic.key,
    name: topic.name,
    aliases: topic.aliases,
  };
}

function exists(topic: NamedTopic): ApiError {
  return new ApiError(
    409,
    'topic_exists',
    `topic:${topic.key} (“${topic.name}”) is called ${topic.matched === topic.name ? 'that' : `“${topic.matched}”`} already`,
    { identifier: formatIdentifier({ kind: 'topic', key: topic.key }), name: topic.name, matched: topic.matched },
  );
}

/** A topic's slug as a `broader` names it now: following renames and merges. Refuses one that is no topic. */
async function currentTopicKey(db: Reader, slug: string): Promise<string> {
  const page = await findPage(`topic:${slug}`, db as Database);
  if (!page || page.kind !== 'topic') {
    throw new ApiError(422, 'validation_error', `broader: there is no topic:${slug}; make it first`);
  }
  return page.key;
}

/** `broader` as given, each a topic that exists, by its current slug, once, never the topic itself. */
async function checkBroader(db: Reader, broader: readonly string[], self: string | null): Promise<string[]> {
  const out: string[] = [];
  for (const slug of broader) {
    const key = await currentTopicKey(db, slug.trim().toLowerCase());
    if (key === self) throw new ApiError(422, 'validation_error', 'broader: a topic is not broader than itself');
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

function encodeTopicFile(file: TopicFile): string {
  const out: TopicFile = { name: file.name };
  if (file.aliases && file.aliases.length > 0) out.aliases = file.aliases;
  if (file.broader && file.broader.length > 0) out.broader = file.broader;
  return `${JSON.stringify(out, null, 2)}\n`;
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
  aliases?: string[];
  /** Broader topics, by slug. */
  broader?: string[];
  /** Its address; made from the name when absent. */
  slug?: string;
  /** The article's first words, "What it is", in Markdown. */
  summary?: string;
}

/** The section a topic's article starts with, from the form's "What it is". */
const SUMMARY_PATH = 'community/10-what-it-is.md';

/**
 * Makes a topic: its page, and its `topic.json` (and the article's first section, if given) committed by whoever makes
 * it, so the path rules check it as any edit. Refuses a name or alias another topic has (`topic_exists`), and an
 * address that is taken. Anyone verified may (`rules.ts`).
 */
export async function createTopic(input: NewTopic, actor: Actor, database: Database = getDb()): Promise<PageRow> {
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const name = input.name.replace(/\s+/g, ' ').trim();
  const aliases = (input.aliases ?? []).map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const slug = (input.slug?.trim().toLowerCase() || topicSlug(name)) ?? '';
  if (!slug) throw new ApiError(422, 'validation_error', 'slug: give the topic an address in Latin letters or digits');
  const problem = keyProblem('topic', slug);
  if (problem) throw new ApiError(422, 'validation_error', `slug: topic:${slug} ${problem}`);
  const broader = await checkBroader(database, input.broader ?? [], slug);
  const file = parseTopicFile({
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(broader.length > 0 ? { broader } : {}),
  });
  const [taken] = await topicsNamed([file.name, ...(file.aliases ?? [])], { database });
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

/** A topic by identifier (`topic:linear-attention`, following renames and merges) or by one of its names. */
async function findTopic(ref: { topic?: string; name?: string }, database: Database): Promise<PageRow | null> {
  if (ref.topic) {
    const page = await findPage(ref.topic.startsWith('topic:') ? ref.topic : `topic:${ref.topic}`, database);
    if (!page || page.kind !== 'topic') throw new ApiError(404, 'not_found', `no topic is ${ref.topic}`);
    return page;
  }
  const [named] = await topicsNamed([ref.name ?? ''], { database });
  return named ? mustPage(database, named.pageId) : null;
}

export interface PaperTopicInput {
  /** The topic by identifier; or else by `name`, which makes it if no topic has that name or alias. */
  topic?: string;
  name?: string;
  label?: TopicLinkLabel;
  note?: string;
}

export interface PaperTopicResult {
  topic: PageRow;
  /** The topic was made for this. */
  created: boolean;
  /** `exists`: the paper was in it already, by this label. */
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
 * Puts a paper in a topic: a labeled link from the paper (`in-topic` unless `introduces-topic` is asked) in its
 * `community/links.jsonl`, or its `owners/links.jsonl` when one of its confirmed authors adds it, so the authors
 * assert it as authors (DESIGN.md §8). By name, the topic is made if no topic has that name or alias. A suggestion
 * of the paper for the topic becomes confirmed.
 */
export async function linkPaperToTopic(
  paper: PageRow,
  input: PaperTopicInput,
  actor: Actor,
  database: Database = getDb(),
): Promise<PaperTopicResult> {
  if (paper.kind !== 'paper') throw new ApiError(422, 'validation_error', 'only a paper is put in a topic');
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  const label = input.label ?? 'in-topic';
  if (!TOPIC_LABELS.includes(label)) throw new ApiError(422, 'validation_error', `label: not a topic label`);
  let topic = await findTopic(input, database);
  let created = false;
  if (!topic) {
    if (!input.name?.trim()) throw new ApiError(422, 'validation_error', 'name a topic, or give its identifier');
    topic = await createTopic({ name: input.name }, actor, database);
    created = true;
  }
  const target = formatIdentifier({ kind: 'topic', key: topic.key });
  const roles = await rolesOf(database, actor, paper.id);
  const part = roles.owner ? 'owners' : 'community';
  const path = `${part}/${LINKS_FILE}`;
  const head = await readHead(database, paper.id);
  // In either part already, by this label: nothing to add.
  for (const each of ['owners', 'community']) {
    const parsed = parseLabeledLinks(await textAt(database, paper.id, head, `${each}/${LINKS_FILE}`), 'paper');
    const links = 'links' in parsed ? parsed.links : [];
    if (links.some((link) => link.label === label && (link.target === target || sameTopic(link.target, topic!)))) {
      await markSuggestion(database, topic.id, paper.id, 'confirmed', actor);
      return { topic, created, status: 'exists' };
    }
  }
  const line: LabeledLinkLine = {
    id: newLinkId(),
    to: target,
    label,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  const content = appendLine(await textAt(database, paper.id, head, path), encodeLabeledLink(line));
  const name = (await topicName(database, topic)) ?? topic.key;
  const result = await commitPage(
    paper.id,
    head,
    actor,
    [{ path, content }],
    label === 'introduces-topic' ? `Introduces the topic ${name}` : `About the topic ${name}`,
    { database },
  );
  if (result.status !== 'committed') throw new ApiError(409, 'page_busy', 'the page changed meanwhile; try again');
  await markSuggestion(database, topic.id, paper.id, 'confirmed', actor);
  await refreshPageIds(database, [paper.id, topic.id]);
  return { topic, created, status: 'linked' };
}

/** Whether a link's target is this topic by an old slug (a rename's redirect). */
function sameTopic(target: string, topic: PageRow): boolean {
  return target === `topic:${topic.key}`;
}

async function topicName(db: Reader, topic: PageRow): Promise<string | null> {
  const { rows } = await db.execute<{ name: string | null }>(
    sql`select name from page_current where page_id = ${topic.id}`,
  );
  return rows[0]?.name ?? null;
}

/** Records a person's decision on a suggestion (made for the occasion if the machine never suggested it). */
async function markSuggestion(
  db: Database,
  topicId: string,
  paperId: string,
  status: 'confirmed' | 'dismissed',
  actor: Actor,
): Promise<void> {
  const decidedBy = actor.kind === 'account' ? actor.accountId : null;
  const decided = { status, decidedBy, decidedAt: new Date() };
  if (status === 'confirmed') {
    await db
      .update(topicSuggestions)
      .set(decided)
      .where(and(eq(topicSuggestions.topicPageId, topicId), eq(topicSuggestions.paperId, paperId)));
    return;
  }
  await db
    .insert(topicSuggestions)
    .values({ topicPageId: topicId, paperId, reason: 'title', matched: '', score: 0, ...decided })
    .onConflictDoUpdate({ target: [topicSuggestions.topicPageId, topicSuggestions.paperId], set: decided });
}

/**
 * Decides a suggestion: `confirm` puts the paper in the topic (`linkPaperToTopic`, `in-topic` unless asked), `dismiss`
 * remembers that it isn't, so the suggestion doesn't come back. Anyone verified may; dismissing is checked against
 * the topic's protection, as an edit to it would be.
 */
export async function decideSuggestion(
  topic: PageRow,
  paper: PageRow,
  decision: { action: 'confirm' | 'dismiss'; label?: TopicLinkLabel },
  actor: Actor,
  database: Database = getDb(),
): Promise<void> {
  if (topic.kind !== 'topic') throw new ApiError(422, 'validation_error', 'only a topic has suggestions');
  if (paper.kind !== 'paper') throw new ApiError(422, 'validation_error', 'a suggestion is of a paper');
  if (decision.action === 'confirm') {
    await linkPaperToTopic(paper, { topic: `topic:${topic.key}`, label: decision.label }, actor, database);
    return;
  }
  const roles = await rolesOf(database, actor, topic.id);
  if (!roles.verified && !roles.admin)
    throw new ApiError(403, 'forbidden', 'confirm an institutional email address first');
  await checkProtection(database, topic.id, roles, [KINDS.topic.kindFile]);
  await markSuggestion(database, topic.id, paper.id, 'dismissed', actor);
  await refreshPageIds(database, [topic.id]);
}

/** A paper as a topic's lists show it. */
export interface TopicPaperRow {
  page: PageSummary;
  year: number | null;
}

/** A topic page one step away (broader, narrower, related), with its rolled-up paper count. */
export interface TopicNeighbour {
  key: string;
  name: string;
  papers: number;
}

export interface TopicSuggestionRow {
  page: PageSummary;
  year: number | null;
  reason: 'keyword' | 'title' | 'abstract';
  matched: string;
}

export interface TopicOverview {
  aliases: string[];
  /** Broader topics; a slug no topic has (any more) as `{ key, name: key, papers: 0, missing: true }`. */
  broader: (TopicNeighbour & { missing?: boolean })[];
  narrower: TopicNeighbour[];
  related: TopicNeighbour[];
  /** The papers that introduced it, directly (not its narrower topics'). */
  introducedBy: TopicPaperRow[];
  venues: OverlapPage[];
  orgs: OverlapPage[];
  /** "Might belong here": open suggestions, best first. */
  suggestions: TopicSuggestionRow[];
  suggestionCount: number;
  /** The topics merged into it, by their old slugs. */
  mergedFrom: string[];
  protection: Protection | null;
}

/** Rolled-up paper counts of topic pages. */
async function topicPaperCounts(db: Reader, ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await db.execute<{ id: string; n: number }>(sql`
    select t.id, count(distinct m.paper_id)::int as n
      from pages t
      join page_members m on m.scope_page_id = t.id
                          or m.scope_page_id in (select page_id from page_ancestors where ancestor_id = t.id)
     where t.id in (${list})
     group by t.id
  `);
  return new Map(rows.map((row) => [row.id, row.n]));
}

async function neighbours(db: Reader, ids: readonly string[]): Promise<TopicNeighbour[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const [found, counts] = await Promise.all([
    db
      .select({
        id: pages.id,
        key: pages.key,
        name: sql<string | null>`(select name from page_current where page_id = ${pages.id})`,
      })
      .from(pages)
      .where(inArray(pages.id, unique)),
    topicPaperCounts(db, unique),
  ]);
  return found
    .map((row) => ({ key: row.key, name: row.name ?? row.key, papers: counts.get(row.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const SUGGESTIONS_SHOWN = 20;

/** What a topic page lists besides its article and its papers. */
export async function topicOverview(page: PageRow, database: Database = getDb()): Promise<TopicOverview> {
  const [current] = (
    await database.execute<{ kind_file: TopicFile | null }>(
      sql`select kind_file from page_current where page_id = ${page.id}`,
    )
  ).rows;
  const file = current?.kind_file ?? null;
  const broaderKeys = file?.broader ?? [];
  const broaderPages = await Promise.all(broaderKeys.map((key) => findPage(`topic:${key}`, database)));
  const { rows: narrowerRows } = await database.execute<{ id: string }>(sql`
    select a.page_id as id from page_ancestors a join pages p on p.id = a.page_id
     where a.ancestor_id = ${page.id} and a.depth = 1 and p.kind = 'topic' and p.merged_into is null
  `);
  const [from, to] = await Promise.all([linksFrom(page.id, database), linksTo(page.id, database)]);
  const relatedIds = [...from, ...to]
    .filter((link) => link.label === 'related' && link.page.kind === 'topic' && link.page.pageId)
    .map((link) => link.page.pageId!)
    .filter((id) => id !== page.id);
  const [broaderFound, narrower, related] = await Promise.all([
    neighbours(
      database,
      broaderPages.flatMap((p) => (p ? [p.id] : [])),
    ),
    neighbours(
      database,
      narrowerRows.map((row) => row.id),
    ),
    neighbours(database, relatedIds),
  ]);
  const missing = broaderKeys
    .filter((_, i) => !broaderPages[i])
    .map((key) => ({ key, name: key, papers: 0, missing: true }));

  const introducing = await database
    .select({ paperId: pageMembers.paperId })
    .from(pageMembers)
    .where(and(eq(pageMembers.scopePageId, page.id), eq(pageMembers.via, 'introduces-topic')));
  const { rows: suggestionRows } = await database.execute<{
    paper_id: string;
    reason: TopicSuggestionRow['reason'];
    matched: string;
    total: number;
  }>(sql`
    select s.paper_id, s.reason, s.matched, (count(*) over ())::int as total
      from topic_suggestions s
     where s.topic_page_id = ${page.id} and s.status = 'open'
     order by s.score desc, s.created_at, s.paper_id
     limit ${SUGGESTIONS_SHOWN}
  `);
  const paperIds = [...introducing.map((row) => row.paperId), ...suggestionRows.map((row) => row.paper_id)];
  const [summaries, years, venues, orgs, protection, merged] = await Promise.all([
    pageSummaries(paperIds, database),
    paperYears(database, paperIds),
    scopeOverlap(page.id, 'venue', { database }),
    scopeOverlap(page.id, 'org', { database }),
    protectionOf(database, page.id),
    database.select({ key: pages.key }).from(pages).where(eq(pages.mergedInto, page.id)),
  ]);
  const paperRow = (id: string) => {
    const summary = summaries.get(id);
    return summary ? { page: summary, year: years.get(id) ?? null } : null;
  };
  return {
    aliases: file?.aliases ?? [],
    broader: [...broaderFound, ...missing],
    narrower,
    related,
    introducedBy: introducing
      .flatMap((row) => paperRow(row.paperId) ?? [])
      .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999)),
    venues,
    orgs,
    suggestions: suggestionRows.flatMap((row) => {
      const found = paperRow(row.paper_id);
      return found ? [{ ...found, reason: row.reason, matched: row.matched }] : [];
    }),
    suggestionCount: suggestionRows[0]?.total ?? 0,
    mergedFrom: merged.map((row) => row.key).sort(),
    protection,
  };
}

async function paperYears(db: Reader, ids: readonly string[]): Promise<Map<string, number | null>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.execute<{ id: string; year: number | null }>(
    sql`select id, year from papers where id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
  return new Map(rows.map((row) => [row.id, row.year]));
}

/** The overview as the API gives it (`GET /pages/{identifier}/topic`), with identifiers and addresses. */
export function presentTopicOverview(overview: TopicOverview, origin: string) {
  const topic = (t: TopicNeighbour & { missing?: boolean }) => ({
    identifier: formatIdentifier({ kind: 'topic', key: t.key }),
    url: t.missing ? null : `${origin}${keyedPagePath('topic', t.key)}`,
    name: t.name,
    papers: t.papers,
  });
  const scope = (kind: 'venue' | 'org') => (p: OverlapPage) => ({
    identifier: formatIdentifier({ kind, key: p.key }),
    url: `${origin}${keyedPagePath(kind, p.key)}`,
    name: p.name,
    papers: p.papers,
  });
  const paper = (row: TopicPaperRow) => ({
    identifier: row.page.identifier,
    url: row.page.url,
    title: row.page.name,
    year: row.year,
  });
  return {
    aliases: overview.aliases,
    broader: overview.broader.map(topic),
    narrower: overview.narrower.map(topic),
    related: overview.related.map(topic),
    introducedBy: overview.introducedBy.map(paper),
    venues: overview.venues.map(scope('venue')),
    orgs: overview.orgs.map(scope('org')),
    suggestions: overview.suggestions.map((row) => ({ ...paper(row), reason: row.reason, matched: row.matched })),
    suggestionCount: overview.suggestionCount,
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
  aliases?: string[];
  /** Broader topics, by slug. */
  broader?: string[];
  /** The whole article (`community/`) as one Markdown text, a `#` heading per section. */
  article?: string;
  /** Related topics, by slug: the page's `related` links to topics, in `community/links.jsonl`. */
  related?: string[];
  summary?: string;
}

/**
 * Edits a topic in one commit: its `topic.json` (name, aliases, broader topics), its article's sections and its
 * related topics. Goes through `commitPage`, so the path rules and page protection hold, a push could do the same, and
 * a change made since `base` is merged.
 */
export async function editTopic(page: PageRow, edit: TopicEdit, actor: Actor, database: Database = getDb()) {
  if (page.kind !== 'topic') throw new ApiError(422, 'validation_error', 'only a topic page is edited here');
  const base = edit.base;
  const commit = base ? await readCommit(database, page.id, base) : null;
  const files = commit ? await readFiles(database, page.id, commit.tree) : new Map<string, string>();
  const changes: FileChange[] = [];

  if (edit.name !== undefined || edit.aliases !== undefined || edit.broader !== undefined) {
    let current: Partial<TopicFile> = {};
    try {
      current = JSON.parse((await readText(database, page.id, files.get(KINDS.topic.kindFile))) ?? '{}');
    } catch {
      // A file that doesn't parse is replaced whole.
    }
    const name = (edit.name ?? current.name ?? '').replace(/\s+/g, ' ').trim();
    const aliases = (edit.aliases ?? current.aliases ?? []).map((a) => a.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const broader =
      edit.broader !== undefined ? await checkBroader(database, edit.broader, page.key) : (current.broader ?? []);
    const file = parseTopicFile({
      name,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(broader.length > 0 ? { broader } : {}),
    });
    const [taken] = await topicsNamed([file.name, ...(file.aliases ?? [])], { except: page.id, database });
    if (taken) throw exists(taken);
    changes.push({ path: KINDS.topic.kindFile, content: encodeTopicFile(file) });
  }

  if (edit.article !== undefined) {
    const sections = await readSections(database, page.id, files, 'community');
    // A heading with nothing under it (the editor's template for an empty article) is no section yet.
    const parts = splitSections(edit.article.replace(/\r\n/g, '\n')).filter(
      (part) => part.text.replace(/^#[^\n]*\n?/, '').trim() !== '',
    );
    changes.push(...planSections(sections, 'community', 0, sections.length, parts));
  }

  if (edit.related !== undefined) {
    const path = `community/${LINKS_FILE}`;
    const parsed = parseLabeledLinks((await readText(database, page.id, files.get(path))) ?? '', 'topic');
    if (!('links' in parsed)) throw new ApiError(422, 'validation_error', `${path} ${parsed.problem}; fix it first`);
    const wanted: string[] = [];
    for (const slug of edit.related) {
      const key = await currentTopicKey(database, slug.trim().toLowerCase());
      if (key !== page.key && !wanted.includes(key)) wanted.push(key);
    }
    const kept = parsed.links.filter((link) => !(link.label === 'related' && link.targetKind === 'topic'));
    const had = parsed.links.filter((link) => link.label === 'related' && link.targetKind === 'topic');
    const lines = [
      ...kept,
      ...wanted.map(
        (key) =>
          had.find((link) => link.target === `topic:${key}`) ?? {
            id: newLinkId(),
            to: `topic:${key}`,
            label: 'related' as const,
          },
      ),
    ].map((link) => encodeLabeledLink(link));
    const content = lines.length > 0 ? `${lines.join('\n')}\n` : null;
    const before = (await readText(database, page.id, files.get(path))) ?? null;
    if (content !== before && (content !== null || files.has(path))) changes.push({ path, content });
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
 * so links, `broader` lists and bookmarks that name the old slug still find it (`page-members.ts` counts the old
 * name among the page's). The page's metadata commit says who moved it. With `name`, the name changes too, in the same
 * person's commit, and the old name stays as an alias.
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
    const file = topicFileOf(files);
    if (file && file.name !== name) {
      const aliases = [file.name, ...(file.aliases ?? [])].filter((a) => topicNameKey(a) !== topicNameKey(name));
      await editTopic(
        moved,
        { base: head, name, aliases: aliases.slice(0, 20), summary: `Rename to ${name}` },
        actor,
        database,
      );
    }
  }
  await refreshPages({ kind: 'topic', key: old });
  await refreshPages({ kind: 'topic', key: slug });
  return moved;
}

const MAX_ALIASES = 20;
const MAX_BROADER = 20;

/**
 * Merges a duplicate topic into another: the survivor gains the duplicate's name and aliases as aliases, its broader
 * topics, its article's sections (each saying where it came from) and its links, in one commit by whoever merges;
 * the duplicate's page is marked merged (`pages.merged_into`), so its address, its identifier and its old slugs lead
 * to the survivor, papers in it are in the survivor (`page-members.ts`), and nobody commits to it again. Its history
 * stays. Dismissed suggestions move along, so they don't come back on the survivor.
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
    // What people decided about its suggestions holds for the survivor; the machine's open ones are made again there.
    await tx.execute(sql`
      insert into topic_suggestions (topic_page_id, paper_id, status, reason, matched, score, decided_by, decided_at, created_at)
      select ${survivor.id}, paper_id, status, reason, matched, score, decided_by, decided_at, created_at
        from topic_suggestions where topic_page_id = ${duplicate.id} and status <> 'open'
      on conflict (topic_page_id, paper_id) do nothing
    `);
    await tx.delete(topicSuggestions).where(eq(topicSuggestions.topicPageId, duplicate.id));
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
  const ours = topicFileOf(survivor);
  const theirs = topicFileOf(duplicate);
  if (ours && theirs) {
    const keys = new Set([topicNameKey(ours.name), ...(ours.aliases ?? []).map(topicNameKey)]);
    const aliases = [...(ours.aliases ?? [])];
    for (const name of [theirs.name, ...(theirs.aliases ?? [])]) {
      const key = topicNameKey(name);
      if (keys.has(key) || aliases.length >= MAX_ALIASES) continue;
      keys.add(key);
      aliases.push(name);
    }
    const broader = [...(ours.broader ?? [])];
    for (const key of theirs.broader ?? []) {
      if (key !== into && key !== from && !broader.includes(key) && broader.length < MAX_BROADER) broader.push(key);
    }
    const next = encodeTopicFile({ name: ours.name, aliases, broader });
    if (next !== survivor.get(KINDS.topic.kindFile)) changes.push({ path: KINDS.topic.kindFile, content: next });
  }

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

/** A topic's open suggestions, best first, a page at a time (`GET /pages/{identifier}/suggestions`). */
export async function topicSuggestionList(
  topicId: string,
  options: { offset?: number; limit?: number; database?: Database } = {},
) {
  const { offset = 0, limit = 50, database = getDb() } = options;
  const { rows } = await database.execute<{
    paper_id: string;
    reason: string;
    matched: string;
    score: number;
    total: number;
  }>(sql`
    select paper_id, reason, matched, score, (count(*) over ())::int as total
      from topic_suggestions
     where topic_page_id = ${topicId} and status = 'open'
     order by score desc, created_at, paper_id
     limit ${limit} offset ${offset}
  `);
  const ids = rows.map((row) => row.paper_id);
  const [summaries, years] = await Promise.all([pageSummaries(ids, database), paperYears(database, ids)]);
  return {
    total: rows[0]?.total ?? 0,
    suggestions: rows.flatMap((row) => {
      const page = summaries.get(row.paper_id);
      return page
        ? [
            {
              identifier: page.identifier,
              url: page.url,
              title: page.name,
              year: years.get(row.paper_id) ?? null,
              reason: row.reason,
              matched: row.matched,
              score: Number(row.score),
            },
          ]
        : [];
    }),
  };
}
