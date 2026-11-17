import { and, eq, like, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { accounts, botGrants, pageCurrent, pages } from '@/db/schema';
import { emailDomain } from '@/lib/email-address';
import {
  formatIdentifier,
  isUnderDomain,
  keyedPagePath,
  keyProblem,
  KINDS,
  type OrgFile,
  orgFileSchema,
  SLUG,
} from '@/lib/kinds';
import { ApiError } from './api/errors';
import { ensureBot } from './bots';
import { IMPORT_RATE_LIMIT } from './import-reviews';
import { addedInstitutionDomains, allInstitutionDomains, domainCandidates, rorIds } from './institution-domains';
import { type Actor, commitPage, createPage } from './pages/commit';
import { findKeyedPage, type PageRow } from './pages/kinds';
import { domainsAbove, isOrgMember } from './org-roles';
import { type OverlapPage, scopeOverlap } from './page-members';
import { orgPeople } from './user-pages';

/**
 * Organisation pages (`handoffs/pages.md` Phase 4): the `orgs` bot, which makes a page per institution from the
 * sign-up allowlist (`config/institution-domains.json` and `institution_domains`, `server/institution-domains.ts`),
 * with its ROR id where `config/institution-ror.json` has one; and departments and labs, child pages that its verified
 * members make (`createOrgChild`).
 *
 * **The bot** (`npm run orgs:sync`; also for a domain when an address there is confirmed, and after each pass of the
 * PDF ingest) is an account like any bot's, granted `org.json` on org pages (migration `0038`). An institution is a
 * name on the allowlist with every domain the list gives that name, so `deepmind.com` and `deepmind.google` are one
 * page. The domains are what make people its members and papers its papers (`page-members.ts`, `org-roles.ts`). By
 * default it makes pages for the institutions in use: those with a confirmed address, an address printed on a
 * paper's page 1, or a domain an admin added by hand; `--all` makes every one (tens of thousands).
 *
 * It never takes anything away and never rewrites what someone else wrote: on a page whose `org.json` is there, it
 * only adds the domains the list gives the institution that the page lacks, and a ROR id if it has none. The page an
 * institution has is the top-level org page whose domains include one of its own, so a page keeps its key whatever
 * the list later calls it.
 */

export const ORGS_BOT = 'orgs';

/** One institution on the allowlist: its name, its domains (shortest first) and its ROR id, if known. */
export interface Institution {
  name: string;
  domains: string[];
  ror: string | null;
}

export interface OrgSyncReport {
  /** Pages made or whose `org.json` the bot wrote, by key. */
  written: string[];
  /** Domains asked for that are on no list. */
  unknown: string[];
}

/** The allowlist by institution: every name with its domains and the ROR id most of them have. */
export function institutionsOf(domains: ReadonlyMap<string, string>, ror: ReadonlyMap<string, string>): Institution[] {
  const byName = new Map<string, string[]>();
  for (const [domain, name] of domains) {
    const list = byName.get(name);
    if (list) list.push(domain);
    else byName.set(name, [domain]);
  }
  return [...byName].map(([name, list]) => {
    const sorted = list.toSorted((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
    const counts = new Map<string, number>();
    for (const domain of sorted) {
      const id = ror.get(domain);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    return { name, domains: sorted.slice(0, MAX_DOMAINS), ror: best?.[0] ?? null };
  });
}

/** As many as `org.json` holds. */
const MAX_DOMAINS = 20;
/** The longest a name may be and still be the page's address. */
const MAX_NAME_KEY = 40;

/** Labels countries register institutions under, which say nothing about which institution: `ac`, `edu`, … */
const REGISTRY_LABELS = new Set([
  'ac',
  'co',
  'com',
  'edu',
  'go',
  'gob',
  'gov',
  'mil',
  'ne',
  'net',
  'or',
  'org',
  'sch',
  'school',
]);

/** Letters and digits as a lower-case slug: "ETH Zürich" → `eth-zurich`; `null` if little of it is Latin. */
export function nameSlug(name: string): string | null {
  const plain = name.normalize('NFKD').replace(/\p{M}/gu, '');
  const letters = [...plain].filter((c) => /\p{L}/u.test(c));
  const latin = letters.filter((c) => /[a-z]/i.test(c));
  if (letters.length === 0 || latin.length / letters.length < 0.9) return null;
  const slug = plain
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length >= 2 && slug.length <= MAX_NAME_KEY && SLUG.test(slug) ? slug : null;
}

/** The label a domain is known by: `ethz.ch` → `ethz`, `ox.ac.uk` → `ox`, `deepmind.google` → `deepmind`. */
export function domainSlug(domain: string): string | null {
  const labels = domain.split('.').slice(0, -1);
  while (labels.length > 1 && REGISTRY_LABELS.has(labels.at(-1)!)) labels.pop();
  const label = labels
    .at(-1)
    ?.replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
  return label && label.length >= 2 && SLUG.test(label) ? label : null;
}

/**
 * The keys an institution's page may have, best first: its name as a slug (`eth-zurich`) if it is short and Latin,
 * else its shortest domain's label (`mit`), then its shortest domain whole (`ucl-ac-uk`), which no other institution
 * has.
 */
export function orgKeyCandidates(institution: Institution): string[] {
  const out: string[] = [];
  const push = (key: string | null) => {
    if (key && !keyProblem('org', key) && !out.includes(key)) out.push(key);
  };
  push(nameSlug(institution.name));
  push(domainSlug(institution.domains[0]));
  for (const domain of institution.domains) push(domain.replace(/\./g, '-'));
  return out;
}

/** What the bot writes into a page's `org.json`: all of it on a new page; missing domains and a ROR id on one it finds. */
export function orgFileUpdate(existing: unknown, wanted: OrgFile): OrgFile | null {
  if (existing === null || existing === undefined) return wanted;
  const parsed = orgFileSchema.safeParse(existing);
  // Someone wrote an org.json that doesn't parse; theirs to fix, not the bot's to overwrite.
  if (!parsed.success) return null;
  const domains = parsed.data.domains ?? [];
  const missing = (wanted.domains ?? []).filter((domain) => !domains.includes(domain));
  const room = Math.max(0, MAX_DOMAINS - domains.length);
  const added = missing.slice(0, room);
  const ror = parsed.data.ror ?? wanted.ror;
  if (added.length === 0 && ror === parsed.data.ror) return null;
  return {
    ...parsed.data,
    ...(added.length > 0 || domains.length > 0 ? { domains: [...domains, ...added] } : {}),
    ...(ror ? { ror } : {}),
  };
}

interface TopOrg {
  id: string;
  key: string;
  head: string | null;
  kindFile: unknown;
}

/** Every top-level org page, by key and by each of its domains. */
async function topOrgs(database: Database) {
  const rows = await database
    .select({ id: pages.id, key: pages.key, head: pageCurrent.head, kindFile: pageCurrent.kindFile })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .where(and(eq(pages.kind, 'org'), sql`position('/' in ${pages.key}) = 0`));
  const byKey = new Map<string, TopOrg>();
  const byDomain = new Map<string, TopOrg>();
  for (const row of rows) {
    const org: TopOrg = { ...row, head: row.head?.toString('hex') ?? null };
    byKey.set(row.key, org);
    const parsed = orgFileSchema.safeParse(row.kindFile);
    for (const domain of parsed.success ? (parsed.data.domains ?? []) : []) {
      if (!byDomain.has(domain)) byDomain.set(domain, org);
    }
  }
  return { byKey, byDomain };
}

/** Whether the `orgs` bot may write `org.json` (migration `0038` grants it). */
async function orgsBotGranted(database: Database): Promise<boolean> {
  const [row] = await database
    .select({ id: botGrants.accountId })
    .from(botGrants)
    .innerJoin(accounts, eq(accounts.id, botGrants.accountId))
    .where(
      and(
        eq(accounts.handle, ORGS_BOT),
        eq(accounts.isBot, true),
        eq(botGrants.kind, 'org'),
        eq(botGrants.pattern, KINDS.org.kindFile),
      ),
    );
  return row !== undefined;
}

/** The domains in use: confirmed addresses, addresses printed on papers' page 1, and those an admin added. */
async function domainsInUse(database: Database): Promise<string[]> {
  const { rows } = await database.execute<{ domain: string }>(sql`
    select split_part(email, '@', 2) as domain from affiliations where verified_at is not null
    union
    select split_part(e.email, '@', 2)
      from page_current c
      join pdf_documents d on d.sha256 = c.pdf ->> 'sha256'
      cross join lateral unnest(d.emails) e(email)
  `);
  return [...rows.map((row) => row.domain), ...(await addedInstitutionDomains(database))];
}

/** The institution a domain is on the list under, by its longest listed suffix, as sign-up matches it. */
function institutionOfDomain(domain: string, listed: ReadonlyMap<string, string>): string | null {
  for (const candidate of domainCandidates(domain)) {
    const name = listed.get(candidate);
    if (name) return name;
  }
  return null;
}

async function writeOrg(
  database: Database,
  bot: Actor,
  institution: Institution,
  orgs: Awaited<ReturnType<typeof topOrgs>>,
  report: OrgSyncReport,
): Promise<void> {
  const wanted: OrgFile = {
    name: institution.name,
    domains: institution.domains,
    ...(institution.ror ? { ror: institution.ror } : {}),
  };
  let org = institution.domains.map((domain) => orgs.byDomain.get(domain)).find(Boolean) ?? null;
  if (!org) {
    // A key no page has: a page that has it and none of the institution's domains is another organisation's.
    const key = orgKeyCandidates(institution).find((candidate) => !orgs.byKey.has(candidate));
    if (!key) return;
    const page = await createPage('org', key, database);
    org = { id: page.id, key, head: page.head, kindFile: null };
    orgs.byKey.set(key, org);
  }
  const next = orgFileUpdate(org.kindFile, wanted);
  if (!next) return;
  const result = await commitPage(
    org.id,
    org.head,
    bot,
    [{ path: KINDS.org.kindFile, content: `${JSON.stringify(next, null, 2)}\n` }],
    org.kindFile ? `Add what the institution list says about ${institution.name}` : `Start ${institution.name}`,
    { database, rateLimit: IMPORT_RATE_LIMIT },
  );
  if (result.status !== 'committed') return;
  report.written.push(org.key);
  org.head = result.oid ?? org.head;
  org.kindFile = next;
  for (const domain of next.domains ?? []) if (!orgs.byDomain.has(domain)) orgs.byDomain.set(domain, org);
}

/**
 * Makes the org pages of the institutions of `domains`, of every institution in use (the default), or of every
 * institution on the list (`all`). Idempotent: a second run writes nothing.
 */
export async function syncOrgPages(
  options: { domains?: readonly string[]; all?: boolean; database?: Database } = {},
): Promise<OrgSyncReport> {
  const database = options.database ?? getDb();
  const listed = await allInstitutionDomains(database);
  const institutions = institutionsOf(listed, rorIds());
  const report: OrgSyncReport = { written: [], unknown: [] };
  let chosen: Institution[];
  if (options.all) {
    chosen = institutions;
  } else {
    const names = new Set<string>();
    for (const domain of options.domains ?? (await domainsInUse(database))) {
      const name = institutionOfDomain(domain.toLowerCase(), listed);
      if (name) names.add(name);
      else if (options.domains) report.unknown.push(domain);
    }
    chosen = institutions.filter((institution) => names.has(institution.name));
  }
  if (chosen.length === 0) return report;
  chosen.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const bot = await ensureBot(ORGS_BOT, database);
  if (!(await orgsBotGranted(database))) {
    throw new ApiError(
      403,
      'forbidden',
      `the ${ORGS_BOT} bot isn't granted ${KINDS.org.kindFile} on org pages: npm run bots:grant -- ${ORGS_BOT} ${KINDS.org.kindFile} --kind org --by <admin>`,
    );
  }
  const orgs = await topOrgs(database);
  for (const institution of chosen) await writeOrg(database, bot, institution, orgs, report);
  return report;
}

/**
 * The org page of an address's institution, made if it isn't there yet: after an address is confirmed, so a new
 * member's organisation has its page. Never fails what called it (a sign-up, a confirmation).
 */
export async function ensureOrgPageFor(email: string, database: Database = getDb()): Promise<void> {
  const domain = emailDomain(email);
  if (!domain) return;
  try {
    // A site that hasn't granted the bot (a test's, a fresh database without migration 0038's grant) has no org pages.
    if (!(await orgsBotGranted(database))) return;
    await syncOrgPages({ domains: [domain], database });
  } catch (err) {
    console.error(`making the org page for ${domain} failed`, err);
  }
}

/** An org page one level under this one: a department or a lab. */
export interface OrgChild {
  key: string;
  name: string;
  /** Its papers, rolled up from the pages under it. */
  papers: number;
}

/** The org pages one level under this one, by name. */
export async function orgChildren(page: PageRow, database: Database = getDb()): Promise<OrgChild[]> {
  const rows = await database
    .select({ id: pages.id, key: pages.key, name: pageCurrent.name })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    // Keys are slugs, so the prefix has no `%` or `_` to escape.
    .where(and(eq(pages.kind, 'org'), like(pages.key, `${page.key}/%`)));
  const children = rows.filter((row) => !row.key.slice(page.key.length + 1).includes('/'));
  if (children.length === 0) return [];
  const ids = sql.join(
    children.map((c) => sql`${c.id}::uuid`),
    sql`, `,
  );
  const { rows: counts } = await database.execute<{ id: string; n: number }>(sql`
    select c.id, count(distinct m.paper_id)::int as n
      from (select ${pages.id} as id from ${pages} where ${pages.id} in (${ids})) c
      join page_members m on m.scope_page_id = c.id
                          or m.scope_page_id in (select page_id from page_ancestors where ancestor_id = c.id)
     group by c.id
  `);
  const papers = new Map(counts.map((row) => [row.id, row.n]));
  return children
    .map((row) => ({ key: row.key, name: row.name ?? row.key, papers: papers.get(row.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The org page one level up, for a department's line; `null` on a top-level org. */
export async function orgParent(page: PageRow, database: Database = getDb()) {
  const at = page.key.lastIndexOf('/');
  if (at <= 0) return null;
  const key = page.key.slice(0, at);
  const [row] = await database
    .select({ name: pageCurrent.name })
    .from(pages)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, pages.id))
    .where(and(eq(pages.kind, 'org'), eq(pages.key, key)));
  return row ? { key, name: row.name ?? key } : null;
}

export interface NewOrgChild {
  /** The last segment of its key: `inf` for `eth/inf`. */
  slug: string;
  name: string;
  /** Its own domains, which must be its organisation's or under them; none to have its papers only from labs under it. */
  domains?: string[];
}

/**
 * Makes a department or lab under an org page: the page, and its `org.json` committed by whoever makes it, so the
 * path rules check it as any edit (`check.ts`: a department's domains are under its organisation's). Its
 * organisation's verified members (`org-roles.ts`) and admins may.
 */
export async function createOrgChild(
  parent: PageRow,
  input: NewOrgChild,
  actor: Actor,
  database: Database = getDb(),
): Promise<PageRow> {
  if (parent.kind !== 'org')
    throw new ApiError(422, 'validation_error', 'departments and labs are under an organisation');
  if (actor.kind !== 'account') throw new ApiError(403, 'forbidden', 'sign in first');
  if (!actor.isAdmin && !(await isOrgMember(database, parent, actor.accountId))) {
    throw new ApiError(
      403,
      'forbidden',
      `only ${formatIdentifier({ kind: 'org', key: parent.key })}'s verified members can add a department or lab`,
    );
  }
  const slug = input.slug.trim().toLowerCase();
  const key = `${parent.key}/${slug}`;
  if (!SLUG.test(slug)) {
    throw new ApiError(422, 'validation_error', 'slug: lower-case letters, digits and dashes, like machine-learning');
  }
  const problem = keyProblem('org', key);
  if (problem) throw new ApiError(422, 'validation_error', `org:${key} ${problem}`);
  const file = orgFileSchema.safeParse({
    name: input.name,
    ...(input.domains && input.domains.length > 0 ? { domains: input.domains.map((d) => d.trim().toLowerCase()) } : {}),
  });
  if (!file.success) {
    const issue = file.error.issues[0];
    throw new ApiError(422, 'validation_error', `${issue.path.join('.') || 'it'}: ${issue.message}`);
  }
  if (await findKeyedPage(database, 'org', key)) {
    throw new ApiError(409, 'page_exists', `org:${key} is there already`);
  }
  // Checked again when committed (`check.ts`); here first, so a refusal leaves no empty page behind.
  const above = await domainsAbove(database, { id: parent.id, kind: 'org', key });
  for (const domain of file.data.domains ?? []) {
    if (!above.some((under) => isUnderDomain(domain, under))) {
      throw new ApiError(
        422,
        'validation_error',
        `domains: ${domain} is not one of ${parent.key}'s domains or under one (${above.join(', ') || 'it has none'})`,
      );
    }
  }
  const page = await createPage('org', key, database);
  try {
    const result = await commitPage(
      page.id,
      page.head,
      actor,
      [{ path: KINDS.org.kindFile, content: `${JSON.stringify(file.data, null, 2)}\n` }],
      `Start ${file.data.name}`,
      { database },
    );
    if (result.status !== 'committed') {
      throw new ApiError(409, 'page_busy', 'the page changed meanwhile; try again');
    }
  } catch (err) {
    await database.delete(pages).where(eq(pages.id, page.id));
    throw err;
  }
  return page;
}

export interface OrgOverview {
  parent: { key: string; name: string } | null;
  children: OrgChild[];
  people: { handles: string[]; count: number };
  venues: OverlapPage[];
  topics: OverlapPage[];
}

/** What an org page lists besides its sections and papers: where it sits, its people, and its venues and topics by count. */
export async function orgOverview(page: PageRow, database: Database = getDb()): Promise<OrgOverview> {
  const [parent, children, people, venues, topics] = await Promise.all([
    orgParent(page, database),
    orgChildren(page, database),
    orgPeople(page.id, {}, database),
    scopeOverlap(page.id, 'venue', { database }),
    scopeOverlap(page.id, 'topic', { database }),
  ]);
  return { parent, children, people, venues, topics };
}

/** The overview as the API gives it (`GET /pages/{identifier}/org`), with identifiers and addresses. */
export function presentOrgOverview(overview: OrgOverview, origin: string) {
  const page = (kind: 'org' | 'venue' | 'topic', key: string) => ({
    identifier: formatIdentifier({ kind, key }),
    url: `${origin}${keyedPagePath(kind, key)}`,
  });
  return {
    parent: overview.parent ? { ...page('org', overview.parent.key), name: overview.parent.name } : null,
    children: overview.children.map((c) => ({ ...page('org', c.key), name: c.name, papers: c.papers })),
    people: overview.people.handles.map((handle) => ({ handle, url: `${origin}${keyedPagePath('user', handle)}` })),
    peopleCount: overview.people.count,
    venues: overview.venues.map((v) => ({ ...page('venue', v.key), name: v.name, papers: v.papers })),
    topics: overview.topics.map((t) => ({ ...page('topic', t.key), name: t.name, papers: t.papers })),
  };
}
