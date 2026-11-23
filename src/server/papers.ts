import { and, eq, gt, sql } from 'drizzle-orm';
import { getDb, getPool, type Database } from '@/db';
import { paperIdentifiers, paperLookupMisses, papers, type Paper } from '@/db/schema';
import type { PaperId, PaperScheme } from '@/lib/paper-ids';
import { arxivSource } from './paper-sources/arxiv';
import { openAlexSource } from './paper-sources/openalex';
import { SourceUnavailable, type PaperSource, type SourcePaper } from './paper-sources/types';
import { SYSTEM_ACTOR } from './pages/check';
import { consume } from './ratelimit';
import { setVersions, versionsAt } from './versions';

/**
 * Finding a paper by identifier, and making its row on the first visit (DESIGN.md §3). A source is only
 * asked about an identifier we know nothing about, within a budget shared by every reader. An answer
 * of "no such paper" is remembered, so crawling made-up ids cannot reach the source.
 */

/** Short, because arXiv's API can lag behind a paper's announcement by hours. */
const MISS_TTL_DAYS = 1;
const MAX_WAIT_SECONDS = 6;
const MERGE_DEPTH_LIMIT = 8;
/** Serializes making rows, so that two identifiers of one paper cannot both make one. */
const CREATE_LOCK = 7_210_001;

export const PAPER_SOURCES: Partial<Record<PaperScheme, PaperSource>> = {
  arxiv: arxivSource,
  doi: openAlexSource,
  // OpenReview submissions come only from an import: there is no on-demand source.
};

export interface FoundPaper {
  paper: Paper;
  identifiers: PaperId[];
  /** The identifier asked for belongs to a duplicate of `paper`: its address should redirect. */
  merged: boolean;
}

export type PaperLookup =
  ({ status: 'found' } & FoundPaper) | { status: 'missing' } | { status: 'unavailable'; retryAfterSeconds: number };

export interface LookupOptions {
  database?: Database;
  sources?: Partial<Record<PaperScheme, PaperSource>>;
}

export async function identifiersOf(paperId: string, database: Database = getDb()): Promise<PaperId[]> {
  return database
    .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
    .from(paperIdentifiers)
    .where(eq(paperIdentifiers.paperId, paperId));
}

/** The known paper for an identifier, following merges to the survivor. */
export async function findPaper(id: PaperId, database: Database = getDb()): Promise<FoundPaper | null> {
  const [row] = await database
    .select({ paper: papers })
    .from(paperIdentifiers)
    .innerJoin(papers, eq(papers.id, paperIdentifiers.paperId))
    .where(and(eq(paperIdentifiers.scheme, id.scheme), eq(paperIdentifiers.value, id.value)));
  if (!row) return null;
  let paper = row.paper;
  for (let depth = 0; paper.mergedInto && depth < MERGE_DEPTH_LIMIT; depth += 1) {
    const [next] = await database.select().from(papers).where(eq(papers.id, paper.mergedInto));
    if (!next) break;
    paper = next;
  }
  return { paper, identifiers: await identifiersOf(paper.id, database), merged: paper.id !== row.paper.id };
}

/**
 * The row for a paper a source described. If any of its identifiers is already known, it is the same
 * paper: that row gains the others, and its metadata stays.
 */
export async function savePaper(source: Omit<SourcePaper, 'versions'>, database: Database = getDb()): Promise<string> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CREATE_LOCK})`);
    let paperId: string | undefined;
    for (const id of source.identifiers) {
      const [known] = await tx
        .select({ paperId: paperIdentifiers.paperId })
        .from(paperIdentifiers)
        .where(and(eq(paperIdentifiers.scheme, id.scheme), eq(paperIdentifiers.value, id.value)));
      if (known) {
        paperId = known.paperId;
        break;
      }
    }
    if (!paperId) {
      const [created] = await tx
        .insert(papers)
        .values({
          title: source.title,
          authors: source.authors,
          abstract: source.abstract,
          source: source.source,
          metadataLicense: source.metadataLicense,
          abstractLicense: source.abstractLicense,
        })
        .returning({ id: papers.id });
      paperId = created.id;
    }
    await tx
      .insert(paperIdentifiers)
      .values(source.identifiers.map((id) => ({ ...id, paperId })))
      .onConflictDoNothing();
    return paperId;
  });
}

/**
 * Asks in flight, so that a page's metadata and body, or two readers of one new paper, share one
 * request. If Next loads this module twice the budget still holds, and the waiter finds the row.
 */
const inFlight = new Map<string, Promise<PaperLookup>>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What sources said lately, so a paper described for the "Add it?" page (`describePaper`) isn't asked for again. */
const described = new Map<string, { paper: SourcePaper; until: number }>();
const DESCRIBED_TTL_MS = 15 * 60_000;

type Described =
  | { status: 'described'; paper: SourcePaper }
  | { status: 'missing' }
  | { status: 'unavailable'; retryAfterSeconds: number };

/** What the source says of a paper, within its budget; a "no such paper" is remembered as a miss. Saves nothing. */
async function askDescription(id: PaperId, source: PaperSource, database: Database): Promise<Described> {
  const key = `${source.name}:${id.scheme}:${id.value}`;
  const kept = described.get(key);
  if (kept && kept.until > Date.now()) return { status: 'described', paper: kept.paper };
  let budget = await consume(`paper-source:${source.name}`, source.budget, getPool());
  // A short wait beats an error page: arXiv allows only one request every three seconds.
  for (let waited = 0; !budget.allowed && waited + budget.retryAfterSeconds <= MAX_WAIT_SECONDS;) {
    const seconds = budget.retryAfterSeconds;
    await sleep(seconds * 1000);
    waited += seconds;
    budget = await consume(`paper-source:${source.name}`, source.budget, getPool());
  }
  if (!budget.allowed) return { status: 'unavailable', retryAfterSeconds: Math.ceil(budget.retryAfterSeconds) };

  let paper: SourcePaper | null;
  try {
    paper = await source.fetch(id.value);
  } catch (err) {
    if (!(err instanceof SourceUnavailable)) throw err;
    console.error(`paper source ${source.name} unavailable:`, err.message);
    return { status: 'unavailable', retryAfterSeconds: 30 };
  }
  if (!paper) {
    const expiresAt = new Date(Date.now() + MISS_TTL_DAYS * 86_400_000);
    await database
      .insert(paperLookupMisses)
      .values({ ...id, expiresAt })
      .onConflictDoUpdate({ target: [paperLookupMisses.scheme, paperLookupMisses.value], set: { expiresAt } });
    return { status: 'missing' };
  }
  described.set(key, { paper, until: Date.now() + DESCRIBED_TTL_MS });
  return { status: 'described', paper };
}

async function knownMiss(id: PaperId, database: Database): Promise<boolean> {
  const [miss] = await database
    .select({ value: paperLookupMisses.value })
    .from(paperLookupMisses)
    .where(
      and(
        eq(paperLookupMisses.scheme, id.scheme),
        eq(paperLookupMisses.value, id.value),
        gt(paperLookupMisses.expiresAt, new Date()),
      ),
    );
  return Boolean(miss);
}

export type PaperDescription =
  | ({ status: 'found' } & FoundPaper)
  | { status: 'described'; paper: SourcePaper }
  | { status: 'missing' }
  | { status: 'unavailable'; retryAfterSeconds: number };

/**
 * The paper for an identifier if we have it, else what its source says of it, without making its page: the
 * "Add it?" page (`app/new/paper`) shows it first, and the papers like it, which it may be a version of.
 */
export async function describePaper(id: PaperId, options: LookupOptions = {}): Promise<PaperDescription> {
  const database = options.database ?? getDb();
  const known = await findPaper(id, database);
  if (known) return { status: 'found', ...known };
  const source = (options.sources ?? PAPER_SOURCES)[id.scheme];
  if (!source || (await knownMiss(id, database))) return { status: 'missing' };
  return askDescription(id, source, database);
}

async function askSource(id: PaperId, source: PaperSource, database: Database): Promise<PaperLookup> {
  const answer = await askDescription(id, source, database);
  if (answer.status !== 'described') return answer;
  // Someone else may have made it meanwhile; `savePaper` then adds to their row.
  await savePaper(answer.paper, database);
  const saved = await findPaper(id, database);
  // A source that answers for an identifier but does not list it is a bug in its adapter.
  if (!saved) throw new Error(`source ${source.name} did not return ${id.scheme}:${id.value}`);
  await startVersions(saved.paper.id, answer.paper, database);
  return { status: 'found', ...saved };
}

/**
 * Gives a paper without versions the ones its source told of, as the system: a paper always has at least one
 * (DESIGN.md §3). One that has some keeps them. Never fails the lookup, which has its paper by now.
 */
export async function startVersions(
  paperId: string,
  described: Pick<SourcePaper, 'versions'>,
  database: Database = getDb(),
): Promise<boolean> {
  if (described.versions.length === 0) return false;
  try {
    const { head, versions } = await versionsAt(paperId, undefined, database);
    if (versions.length > 0) return false;
    await setVersions(
      paperId,
      SYSTEM_ACTOR,
      { baseOid: head, versions: described.versions, summary: 'Add the versions its source lists' },
      { database },
    );
    return true;
  } catch (err) {
    console.error(`could not start the versions of ${paperId}:`, err);
    return false;
  }
}

/** The paper for an identifier in normal form, asking its source if we have never seen it. */
export async function lookupPaper(id: PaperId, options: LookupOptions = {}): Promise<PaperLookup> {
  const database = options.database ?? getDb();
  const known = await findPaper(id, database);
  if (known) return { status: 'found', ...known };

  const source = (options.sources ?? PAPER_SOURCES)[id.scheme];
  if (!source) return { status: 'missing' };

  if (await knownMiss(id, database)) return { status: 'missing' };

  const key = `${source.name}:${id.scheme}:${id.value}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const asked = askSource(id, source, database).finally(() => inFlight.delete(key));
  inFlight.set(key, asked);
  return asked;
}
