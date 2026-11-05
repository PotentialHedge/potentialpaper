import { canonicalPaperId, PATH_PREFIX, PAPER_SCHEMES, paperPath, parsePaperId } from '@/lib/paper-ids';
import { lookupPaper, type LookupOptions } from './papers';

export type PaperGateResult =
  { action: 'render' } | { action: 'redirect'; to: string } | { action: 'missing' } | { action: 'unavailable' };

/**
 * What to answer at a paper's address, decided before the page's cache (`proxy.ts`). Next writes each
 * page it caches to disk, and a cached page cannot decide afterwards not to be cached, so everything
 * but a real paper at its own address is answered here. Otherwise made-up addresses could fill the disk.
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
  if (found.merged) return { action: 'redirect', to: paperPath(canonicalPaperId(found.identifiers) ?? id) };
  return { action: 'render' };
}
