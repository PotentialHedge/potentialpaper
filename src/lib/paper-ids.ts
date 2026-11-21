/**
 * Paper identifiers: parsing what people type or paste, the normal form stored in
 * `paper_identifiers`, and the addresses built from it. Pure, so it can run anywhere.
 */

export const PAPER_SCHEMES = ['arxiv', 'doi', 'openreview'] as const;
export type PaperScheme = (typeof PAPER_SCHEMES)[number];

export interface PaperId {
  scheme: PaperScheme;
  value: string;
}

const ARXIV_NEW = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_OLD = /^([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/;
const DOI = /^10\.\d{4,9}\/[\x21-\x7e]+$/;
const OPENREVIEW = /^[A-Za-z0-9_-]{6,32}$/;
const ARXIV_DOI_PREFIX = '10.48550/arxiv.';
const DOI_MAX = 255;

/** An arXiv id without its version, since a page is for the work. Any version is accepted. */
export function normalizeArxivId(raw: string): string | null {
  const id = raw.trim();
  const lower = id.toLowerCase();
  return ARXIV_NEW.exec(lower)?.[1] ?? ARXIV_OLD.exec(lower)?.[1] ?? null;
}

/**
 * A DOI in lower case (they are case-insensitive), or the arXiv id when it is arXiv's own DOI for a
 * preprint, which is the same paper.
 */
export function parseDoi(raw: string): PaperId | null {
  const doi = raw.trim().toLowerCase();
  if (doi.length > DOI_MAX || !DOI.test(doi)) return null;
  if (doi.startsWith(ARXIV_DOI_PREFIX)) {
    const arxiv = normalizeArxivId(doi.slice(ARXIV_DOI_PREFIX.length));
    if (arxiv) return { scheme: 'arxiv', value: arxiv };
  }
  return { scheme: 'doi', value: doi };
}

/** The normal form of an identifier in the given scheme, or `null` if it cannot be one. */
export function parsePaperId(scheme: PaperScheme, raw: string): PaperId | null {
  switch (scheme) {
    case 'arxiv': {
      const value = normalizeArxivId(raw);
      return value ? { scheme, value } : null;
    }
    case 'doi':
      return parseDoi(raw);
    case 'openreview':
      return OPENREVIEW.test(raw) ? { scheme, value: raw } : null;
  }
}

/** The identifier in something typed into search: a bare id, `arXiv:…`, or a link to the paper. */
export function paperIdFromText(text: string): PaperId | null {
  const input = text.trim();
  if (input.length > DOI_MAX + 30 || /\s/.test(input)) return null;
  const arxivUrl = /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/i.exec(input);
  if (arxivUrl) return parsePaperId('arxiv', arxivUrl[1]);
  const doiUrl = /^(?:https?:\/\/)?(?:dx\.)?doi\.org\/(.+)$/i.exec(input);
  if (doiUrl) return parseDoi(doiUrl[1]);
  const openReviewUrl = /^(?:https?:\/\/)?openreview\.net\/forum\?id=([^&#]+)/i.exec(input);
  if (openReviewUrl) return parsePaperId('openreview', openReviewUrl[1]);
  const prefixed = /^(arxiv|doi):(.+)$/i.exec(input);
  if (prefixed) {
    return prefixed[1].toLowerCase() === 'arxiv' ? parsePaperId('arxiv', prefixed[2]) : parseDoi(prefixed[2]);
  }
  return parsePaperId('arxiv', input) ?? parseDoi(input);
}

/** A paper's address: its page's short id (`/s/<n>`), which every identifier's address leads to (`proxy.ts`). */
export function shortPath(shortId: number): string {
  return `/s/${shortId}`;
}

export const PATH_PREFIX: Record<PaperScheme, string> = { arxiv: '/abs', doi: '/doi', openreview: '/openreview' };

/** The page of an identifier. Slashes in old arXiv ids and in DOIs stay path separators. */
export function paperPath({ scheme, value }: PaperId): string {
  return `${PATH_PREFIX[scheme]}/${value.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * A paper's page for OpenReview's own addresses, so changing the domain in an OpenReview link works as it does for
 * arXiv's: `/forum?id=abc` and `/pdf?id=abc` → `/openreview/abc`. `null` for any other path.
 */
export function openReviewAliasPath(pathname: string, search: URLSearchParams): string | null {
  if (pathname !== '/forum' && pathname !== '/pdf') return null;
  const id = parsePaperId('openreview', search.get('id') ?? '');
  return id ? paperPath(id) : null;
}

const CANONICAL_ORDER: PaperScheme[] = ['arxiv', 'doi', 'openreview'];

/** The identifier a paper is best known by, which its canonical address uses. */
export function canonicalPaperId<T extends PaperId>(ids: readonly T[]): T | undefined {
  return [...ids].sort((a, b) => CANONICAL_ORDER.indexOf(a.scheme) - CANONICAL_ORDER.indexOf(b.scheme))[0];
}

/** Where to read the paper itself. */
export function sourceLinks({ scheme, value }: PaperId): { label: string; url: string }[] {
  switch (scheme) {
    case 'arxiv':
      return [
        { label: `arXiv:${value}`, url: `https://arxiv.org/abs/${value}` },
        { label: 'PDF', url: `https://arxiv.org/pdf/${value}` },
      ];
    case 'doi':
      return [{ label: `doi:${value}`, url: `https://doi.org/${value}` }];
    case 'openreview':
      return [{ label: 'OpenReview', url: `https://openreview.net/forum?id=${encodeURIComponent(value)}` }];
  }
}

/** Sites PDFs are copied from, by host, with the name to credit them by. */
const SOURCE_NAMES: Record<string, string> = {
  'openreview.net': 'OpenReview',
  'arxiv.org': 'arXiv',
};

/** The name of the site a URL is on, to credit a copy to: "OpenReview", or the bare host. */
export function sourceName(url: string): string {
  const host = URL.parse(url)?.hostname.replace(/^www\./, '') ?? '';
  return SOURCE_NAMES[host] ?? (host || 'the source');
}

/** A paper's agent page (`app/agent/[prefix]/[...id]`): its page as Markdown, and the agents' discussion of it. */
export function agentPaperPath(id: PaperId): string {
  return `/agent${paperPath(id)}`;
}
