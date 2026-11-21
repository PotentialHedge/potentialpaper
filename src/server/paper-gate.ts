import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { pages, papers } from '@/db/schema';
import { canonicalPaperId, PATH_PREFIX, PAPER_SCHEMES, paperPath, parsePaperId, shortPath } from '@/lib/paper-ids';
import { identifiersOf, lookupPaper, type LookupOptions } from './papers';

export type PaperGateResult = { action: 'redirect'; to: string } | { action: 'missing' } | { action: 'unavailable' };

/**
 * What to answer at an identifier's address (`/abs/…`, `/doi/…`, `/openreview/…`), decided before the page's cache
 * (`proxy.ts`): a paper's page is at its short address, `/s/<n>`, so every one of them leads there, or is missing.
 * Next writes each page it caches to disk, so made-up addresses are answered here and never rendered.
 */
export async function paperGate(pathname: string, options: LookupOptions = {}): Promise<PaperGateResult> {
  const scheme = PAPER_SCHEMES.find((s) => pathname === PATH_PREFIX[s] || pathname.startsWith(`${PATH_PREFIX[s]}/`));
  if (!scheme) return { action: 'missing' };

  let raw: string;
  try {
    raw = pathname
      .slice(PATH_PREFIX[scheme].length + 1)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
  } catch {
    return { action: 'missing' };
  }
  const id = parsePaperId(scheme, raw);
  if (!id) return { action: 'missing' };
  // Another spelling of the identifier, a version, or arXiv's own DOI for a preprint.
  if (id.scheme !== scheme || id.value !== raw) return { action: 'redirect', to: paperPath(id) };

  const found = await lookupPaper(id, options);
  if (found.status === 'missing') return { action: 'missing' };
  if (found.status === 'unavailable') return { action: 'unavailable' };
  // A paper's page is at its short address only, `/s/<n>`, whatever identifier it was reached by.
  const shortId = await shortIdOf(found.paper.id, options.database);
  if (shortId === null) throw new Error(`paper ${found.paper.id} has no page`);
  return { action: 'redirect', to: shortPath(shortId) };
}

async function shortIdOf(pageId: string, database = getDb()): Promise<number | null> {
  const [row] = await database.select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, pageId));
  return row?.shortId ?? null;
}

export type ShortGateResult =
  { action: 'render'; path: string } | { action: 'redirect'; to: string } | { action: 'other' } | { action: 'missing' };

/**
 * What to answer at `/s/<n>`: a paper is rendered there, from the route of its canonical identifier (`rewrite`, so the
 * address stays short); a merged paper leads to its survivor's; any other kind's short link is `app/s/[n]`'s.
 */
export async function shortGate(ref: string, database = getDb()): Promise<ShortGateResult> {
  if (!/^\d{1,9}$/.test(ref)) return { action: 'missing' };
  const [row] = await database
    .select({ id: pages.id, kind: pages.kind, mergedInto: papers.mergedInto })
    .from(pages)
    .leftJoin(papers, and(eq(papers.id, pages.id), eq(pages.kind, 'paper')))
    .where(eq(pages.shortId, Number(ref)));
  if (!row) return { action: 'missing' };
  if (row.kind !== 'paper') return { action: 'other' };
  let paperId = row.id;
  let mergedInto = row.mergedInto;
  for (let hops = 0; mergedInto && hops < 8; hops += 1) {
    paperId = mergedInto;
    const [next] = await database.select({ mergedInto: papers.mergedInto }).from(papers).where(eq(papers.id, paperId));
    mergedInto = next?.mergedInto ?? null;
  }
  if (paperId !== row.id) {
    const shortId = await shortIdOf(paperId, database);
    return shortId === null ? { action: 'missing' } : { action: 'redirect', to: shortPath(shortId) };
  }
  const canonical = canonicalPaperId(await identifiersOf(paperId, database));
  return canonical ? { action: 'render', path: paperPath(canonical) } : { action: 'missing' };
}
