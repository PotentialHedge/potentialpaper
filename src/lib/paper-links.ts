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
  extra = [],
}: {
  identifiers: readonly PaperId[];
  title: string;
  pdf?: string | null;
  /** Submissions' pages, kept only where they are on OpenReview. */
  forums?: readonly (string | null)[];
  /** The page's own `links.json`: one with a built-in link's label replaces it, the rest follow. */
  extra?: readonly TitleLink[];
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
  const own = new Map(extra.map((link) => [link.label.toLowerCase(), link]));
  const merged = links
    .filter((link): link is TitleLink => link !== null)
    .map((link) => {
      const replaced = own.get(link.label.toLowerCase());
      own.delete(link.label.toLowerCase());
      return replaced ?? link;
    });
  return [...merged, ...own.values()];
}

export const MAX_LINKS = 12;
export const MAX_LINK_LABEL = 30;
const MAX_LINK_URL = 2000;

/** A link's problem, or `null`. Only http(s), so a link can't run anything. */
export function linkProblem(link: TitleLink): string | null {
  const label = link.label.trim();
  if (label === '' || label.length > MAX_LINK_LABEL) return `needs a label of 1 to ${MAX_LINK_LABEL} characters`;
  if (/[[\]\p{C}]/u.test(label)) return 'has a label with a bracket or a control character';
  const url = URL.parse(link.url);
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || link.url.length > MAX_LINK_URL) {
    return 'needs an http or https address';
  }
  return null;
}

/** The links in a `links.json`, or `null` if it isn't a list of good, distinct links. */
export function parseLinksFile(text: string): TitleLink[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_LINKS) return null;
  const links: TitleLink[] = [];
  const labels = new Set<string>();
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
    const { label, url } = item as Record<string, unknown>;
    if (typeof label !== 'string' || typeof url !== 'string') return null;
    const link = { label: label.trim(), url };
    if (linkProblem(link) || labels.has(link.label.toLowerCase())) return null;
    labels.add(link.label.toLowerCase());
    links.push(link);
  }
  return links;
}

export function encodeLinksFile(links: readonly TitleLink[]): string {
  return `${JSON.stringify(
    links.map(({ label, url }) => ({ label, url })),
    null,
    2,
  )}\n`;
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
