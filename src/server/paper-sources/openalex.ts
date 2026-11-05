import { normalizeArxivId, parseDoi, type PaperId } from '@/lib/paper-ids';
import { fetchSource, tidy, type PaperSource, type SourcePaper } from './types';

const FIELDS =
  'title,publication_year,doi,authorships,primary_location,best_oa_location,locations,abstract_inverted_index';

interface Location {
  landing_page_url?: string | null;
  license?: string | null;
  source?: { display_name?: string | null } | null;
}

interface Work {
  title?: string | null;
  publication_year?: number | null;
  doi?: string | null;
  authorships?: { raw_author_name?: string | null; author?: { display_name?: string | null } }[];
  primary_location?: Location | null;
  best_oa_location?: Location | null;
  locations?: Location[];
  abstract_inverted_index?: Record<string, number[]> | null;
}

function abstractText(index: Record<string, number[]>): string {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word;
  }
  return tidy(words.filter(Boolean).join(' '));
}

/**
 * Whether we may show the abstract. OpenAlex's own data is CC0, but an abstract can still belong to its
 * publisher (DESIGN.md §3), so it is kept only from a work under an open license.
 */
function openlyLicensed(work: Work): boolean {
  const license = work.best_oa_location?.license ?? work.primary_location?.license;
  return !!license && /^(cc|public-domain)/i.test(license);
}

export function parseOpenAlexWork(work: Work, doi: string): SourcePaper | null {
  if (!work.title) return null;
  const identifiers: PaperId[] = [{ scheme: 'doi', value: doi }];
  for (const location of work.locations ?? []) {
    const match = /arxiv\.org\/abs\/(.+)$/i.exec(location.landing_page_url ?? '');
    const arxiv = match && normalizeArxivId(match[1]);
    if (arxiv) {
      identifiers.push({ scheme: 'arxiv', value: arxiv });
      break;
    }
  }
  return {
    title: tidy(work.title),
    authors: (work.authorships ?? [])
      .map((a) => tidy(a.raw_author_name ?? a.author?.display_name ?? ''))
      .filter(Boolean),
    abstract:
      work.abstract_inverted_index && openlyLicensed(work) ? abstractText(work.abstract_inverted_index) || null : null,
    year: work.publication_year ?? null,
    venue: work.primary_location?.source?.display_name ?? null,
    identifiers,
  };
}

/** For DOIs. Well inside OpenAlex's published limits, and spends only on first visits. */
export const openAlexSource: PaperSource = {
  name: 'openalex',
  budget: { burst: 10, perSecond: 1 },
  async fetch(doi) {
    const parsed = parseDoi(doi);
    if (parsed?.scheme !== 'doi') return null;
    const res = await fetchSource(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?select=${FIELDS}`);
    return res && parseOpenAlexWork((await res.json()) as Work, doi);
  },
};
