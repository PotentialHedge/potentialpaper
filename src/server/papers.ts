import { and, eq, gt, sql } from 'drizzle-orm';
import { getDb, getPool, type Database } from '@/db';
import { paperIdentifiers, paperLookupMisses, papers, type Paper } from '@/db/schema';
import type { PaperId, PaperScheme } from '@/lib/paper-ids';
import { arxivSource } from './paper-sources/arxiv';
import { openAlexSource } from './paper-sources/openalex';
import { SourceUnavailable, type PaperSource, type SourcePaper } from './paper-sources/types';
import { consume } from './ratelimit';

/**
 * Finding a paper by identifier, and making its row on the first visit (DESIGN.md §3). A source is only
 * asked about an identifier we know nothing about, within a budget shared by every reader. An answer
 * of "no such paper" is remembered, so crawling made-up ids cannot reach the source.
 */

const MISS_TTL_DAYS = 7;
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

interface Options {
  database?: Database;
  sources?: Partial<Record<PaperScheme, PaperSource>>;
}

async function identifiersOf(paperId: string, database: Database): Promise<PaperId[]> {
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
export async function savePaper(source: SourcePaper, database: Database = getDb()): Promise<string> {
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
          year: source.year,
          venue: source.venue,
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

/** The paper for an identifier in normal form, asking its source if we have never seen it. */
export async function lookupPaper(id: PaperId, options: Options = {}): Promise<PaperLookup> {
  const database = options.database ?? getDb();
  const known = await findPaper(id, database);
  if (known) return { status: 'found', ...known };

  const source = (options.sources ?? PAPER_SOURCES)[id.scheme];
  if (!source) return { status: 'missing' };

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
  if (miss) return { status: 'missing' };

  const budget = await consume(`paper-source:${source.name}`, source.budget, getPool());
  if (!budget.allowed) return { status: 'unavailable', retryAfterSeconds: Math.ceil(budget.retryAfterSeconds) };

  let described: SourcePaper | null;
  try {
    described = await source.fetch(id.value);
  } catch (err) {
    if (!(err instanceof SourceUnavailable)) throw err;
    console.error(`paper source ${source.name} unavailable:`, err.message);
    return { status: 'unavailable', retryAfterSeconds: 30 };
  }
  if (!described) {
    const expiresAt = new Date(Date.now() + MISS_TTL_DAYS * 86_400_000);
    await database
      .insert(paperLookupMisses)
      .values({ ...id, expiresAt })
      .onConflictDoUpdate({ target: [paperLookupMisses.scheme, paperLookupMisses.value], set: { expiresAt } });
    return { status: 'missing' };
  }
  await savePaper(described, database);
  const saved = await findPaper(id, database);
  // A source that answers for an identifier but does not list it is a bug in its adapter.
  if (!saved) throw new Error(`source ${source.name} did not return ${id.scheme}:${id.value}`);
  return { status: 'found', ...saved };
}
