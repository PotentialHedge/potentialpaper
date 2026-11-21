import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb, type Database } from '@/db';
import { botGrants, pageCurrent, paperIdentifiers, papers } from '@/db/schema';
import type { PaperId, PaperScheme } from '@/lib/paper-ids';
import type { PaperVersion, VersionPdf } from '@/lib/versions';
import { ApiError } from './api/errors';
import type { Principal } from './auth';
import { versionPdfAt } from './files';
import type { Actor } from './pages/check';
import { commitPage, type CommitResult } from './pages/commit';
import { grantCovers } from './pages/rules';
import { findPaper } from './papers';
import { versionChanges } from './pages/content';
import { attachPdf, mergeFoundVersions, setVersions, versionsAt } from './versions';

/**
 * What import tools call (`/api/v1/imports/*`): programs outside the platform that bring in a venue's papers,
 * reviews, versions and PDFs, each as a bot an admin granted the paths it writes (`npm run bots:grant`). Only a
 * bot's API token reaches these; a person, signed in or with a token, never does. Every write is a commit by the
 * bot, checked by the same path rules as anyone's, so a bot writes only what its grants cover.
 */

/** The bot behind a request, or a 403: a token, of a bot account with at least one grant. */
export async function requireImporter(principal: Principal, database: Database = getDb()) {
  if (principal.via !== 'token' || !principal.account.isBot) {
    throw new ApiError(403, 'forbidden', "only an import bot's API token may call this");
  }
  const grants = await database
    .select({ kind: botGrants.kind, pattern: botGrants.pattern })
    .from(botGrants)
    .where(eq(botGrants.accountId, principal.account.id));
  if (grants.length === 0) throw new ApiError(403, 'forbidden', 'this bot has no grants; an admin grants them');
  const actor: Actor = { kind: 'account', accountId: principal.account.id, isAdmin: false };
  return { actor, grants };
}

/** Whether the bot imports from `source`: it is granted that source's reviews on papers (`reviews/<source>/**`). */
export function importsFrom(grants: readonly { kind: string; pattern: string }[], source: string): boolean {
  return grants.some((g) => g.kind === 'paper' && grantCovers(g.pattern, `reviews/${source}/x/submission.json`));
}

/** A paper as an import tool matches against it. */
export interface ImportPaper {
  id: string;
  identifiers: PaperId[];
  title: string;
  abstract: string | null;
  venue: string | null;
  year: number | null;
  /** The PDF its page shows (its newest version's), if any. */
  pdf: VersionPdf | null;
}

/** Papers with an identifier of `scheme`, in id order, after the paper `after`; at most `limit`. Merged ones are left out. */
export async function importPapers(
  { scheme, after, limit }: { scheme: PaperScheme; after?: string; limit: number },
  database: Database = getDb(),
): Promise<{ papers: ImportPaper[]; next: string | null }> {
  const rows = await database
    .select({
      id: papers.id,
      title: papers.title,
      abstract: papers.abstract,
      venue: papers.venue,
      year: papers.year,
      pdf: pageCurrent.pdf,
      identifiers: sql<PaperId[]>`(
        select coalesce(json_agg(json_build_object('scheme', i.scheme, 'value', i.value) order by i.scheme, i.value), '[]')
        from paper_identifiers i where i.paper_id = ${papers.id})`,
    })
    .from(papers)
    .leftJoin(pageCurrent, eq(pageCurrent.pageId, papers.id))
    .where(
      and(
        isNull(papers.mergedInto),
        after ? gt(papers.id, after) : undefined,
        sql`exists (select 1 from ${paperIdentifiers} i where i.paper_id = ${papers.id} and i.scheme = ${scheme})`,
      ),
    )
    .orderBy(papers.id)
    .limit(limit + 1);
  const more = rows.length > limit;
  const list = rows.slice(0, limit).map((r) => ({ ...r, pdf: (r.pdf as VersionPdf | null) ?? null }));
  return { papers: list, next: more ? list[list.length - 1].id : null };
}

async function paperOf(id: PaperId, database: Database) {
  const found = await findPaper(id, database);
  if (!found) throw new ApiError(404, 'not_found', 'no paper with that identifier');
  return found;
}

/**
 * Versions a source lists for the paper, folded into the page's by address (`mergeFoundVersions`): one already there
 * takes what the source says now and keeps what people wrote; the rest are added.
 */
export async function importVersions(
  actor: Actor,
  input: {
    paper: PaperId;
    versions: (Omit<PaperVersion, 'id' | 'pdf'> & { url: string })[];
    relabel?: boolean;
    summary?: string;
  },
  database: Database = getDb(),
): Promise<{ result: CommitResult; identifiers: PaperId[] }> {
  const { paper, identifiers } = await paperOf(input.paper, database);
  const { head, versions } = await versionsAt(paper.id, undefined, database);
  const merged = mergeFoundVersions(versions, input.versions, { relabel: input.relabel });
  const result = await setVersions(
    paper.id,
    actor,
    {
      baseOid: head,
      versions: merged.map((v) => ({ ...v, pdf: v.pdf ? { url: v.pdf.url, license: v.pdf.license } : undefined })),
      summary: input.summary ?? 'Import the versions',
    },
    { database },
  );
  return { result, identifiers };
}

/**
 * A stored PDF (`POST /api/v1/files`) as the PDF of the version at `at.url`, its own address or a forum one of its
 * submissions names, or of a new version there. Nothing is committed if that version already has those bytes.
 */
export async function importPdf(
  actor: Actor,
  input: {
    paper: PaperId;
    pdf: { url: string; license?: string | null; source?: string | null };
    at: { url: string; label: string };
  },
  database: Database = getDb(),
): Promise<{ result: CommitResult; identifiers: PaperId[] }> {
  const { paper, identifiers } = await paperOf(input.paper, database);
  const stored = await versionPdfAt(input.pdf.url, database);
  const pdf: VersionPdf = {
    ...stored,
    ...(input.pdf.source ? { source: input.pdf.source } : {}),
    ...(input.pdf.license ? { license: input.pdf.license } : {}),
  };
  const { head, versions } = await versionsAt(paper.id, undefined, database);
  const after = attachPdf(versions, pdf, input.at);
  const result = await commitPage(paper.id, head, actor, versionChanges(versions, after), 'Add the PDF', {
    database,
    evidence: [input.at.url],
  });
  return { result, identifiers };
}
