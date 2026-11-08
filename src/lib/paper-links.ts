/**
 * What a paper page shows under its title: links to the paper elsewhere, and its BibTeX entry. Pure, so
 * the page, the client island and the tests share it.
 */
import type { PaperId } from './paper-ids';

export interface TitleLink {
  label: string;
  url: string;
}

/**
 * `[arXiv] [PDF] [OpenReview] [DOI] [Scholar]`, each at most once. The PDF is our copy when there is one,
 * else arXiv's. OpenReview comes from the identifier or from a submission's forum.
 */
export function titleLinks({
  identifiers,
  title,
  pdf,
  forums = [],
}: {
  identifiers: readonly PaperId[];
  title: string;
  pdf?: string | null;
  /** Submissions' pages, kept only where they are on OpenReview. */
  forums?: readonly (string | null)[];
}): TitleLink[] {
  const arxiv = identifiers.find((id) => id.scheme === 'arxiv')?.value;
  const doi = identifiers.find((id) => id.scheme === 'doi')?.value;
  const openreview = identifiers.find((id) => id.scheme === 'openreview')?.value;
  const forum = openreview
    ? `https://openreview.net/forum?id=${encodeURIComponent(openreview)}`
    : forums.find((url) => url && URL.parse(url)?.hostname.replace(/^www\./, '') === 'openreview.net');
  const pdfUrl = pdf ?? (arxiv ? `https://arxiv.org/pdf/${arxiv}` : null);
  const links: (TitleLink | null)[] = [
    arxiv ? { label: 'arXiv', url: `https://arxiv.org/abs/${arxiv}` } : null,
    pdfUrl ? { label: 'PDF', url: pdfUrl } : null,
    forum ? { label: 'OpenReview', url: forum } : null,
    doi ? { label: 'DOI', url: `https://doi.org/${doi}` } : null,
    {
      label: 'Scholar',
      url: `https://scholar.google.com/scholar?${new URLSearchParams({ q: `"${title}"` })}`,
    },
  ];
  return links.filter((link): link is TitleLink => link !== null);
}

/** Braces protect capitals and stop a stray `{` or `}` from unbalancing the entry. */
function field(value: string): string {
  return `{${value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()}}`;
}

function surname(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? '';
}

/** A key as Google Scholar builds one: first author's surname, year, first long word of the title. */
export function bibtexKey(paper: { title: string; authors: readonly string[]; year: number | null }): string {
  const ascii = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]/g, '')
      .toLowerCase();
  const word =
    paper.title
      .split(/\s+/)
      .map(ascii)
      .find((w) => w.length > 3 && !STOP.has(w)) ?? '';
  return `${ascii(surname(paper.authors[0] ?? '')) || 'anon'}${paper.year ?? ''}${word}`;
}

const STOP = new Set(['with', 'from', 'that', 'this', 'into', 'over', 'what', 'when', 'towards', 'toward']);

/** The paper's BibTeX entry: `@article` with an arXiv eprint, `@inproceedings` at a venue, else `@misc`. */
export function bibtex({
  paper,
  identifiers,
  url,
}: {
  paper: { title: string; authors: readonly string[]; year: number | null; venue: string | null };
  identifiers: readonly PaperId[];
  /** The page's own address. */
  url?: string;
}): string {
  const arxiv = identifiers.find((id) => id.scheme === 'arxiv')?.value;
  const doi = identifiers.find((id) => id.scheme === 'doi')?.value;
  const type = paper.venue ? 'inproceedings' : arxiv ? 'article' : 'misc';
  const fields: [string, string | null | undefined][] = [
    ['title', paper.title],
    ['author', paper.authors.length > 0 ? paper.authors.join(' and ') : null],
    ['booktitle', paper.venue],
    ['journal', !paper.venue && arxiv ? `arXiv preprint arXiv:${arxiv}` : null],
    ['year', paper.year?.toString()],
    ['eprint', arxiv],
    ['archivePrefix', arxiv ? 'arXiv' : null],
    ['doi', doi],
    ['url', url],
  ];
  const body = fields
    .filter((f): f is [string, string] => Boolean(f[1]))
    .map(([k, v]) => `  ${k} = ${field(v)}`)
    .join(',\n');
  return `@${type}{${bibtexKey(paper)},\n${body}\n}`;
}
