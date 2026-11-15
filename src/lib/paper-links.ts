/**
 * What a paper page shows under its title: links to the paper elsewhere, and its BibTeX entry. Pure, so
 * the page, the client island and the tests share it.
 */
import { z } from 'zod';
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
  /** The page's own links (`links/`): one with a built-in link's label replaces it, the rest follow. */
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
  return mergeLinks(
    links.filter((link): link is TitleLink => link !== null),
    extra,
  );
}

/** The built-in links with the page's own: one with a built-in link's label replaces it, the rest follow. */
export function mergeLinks(builtIn: readonly TitleLink[], extra: readonly TitleLink[]): TitleLink[] {
  const own = new Map(extra.map((link) => [link.label.toLowerCase(), link]));
  const merged = builtIn.map((link) => {
    const replaced = own.get(link.label.toLowerCase());
    own.delete(link.label.toLowerCase());
    return replaced ?? link;
  });
  return [...merged, ...own.values()];
}

export const MAX_LINKS = 12;
export const MAX_LINK_LABEL = 30;
const MAX_LINK_URL = 2000;

/** An `http:` or `https:` address, so a link can't run anything. */
export function httpUrl(max: number) {
  return z
    .string()
    .max(max)
    .regex(/^https?:\/\//i)
    .refine((value) => {
      const url = URL.parse(value);
      return url !== null && (url.protocol === 'https:' || url.protocol === 'http:');
    })
    .meta({ format: 'uri' });
}

/**
 * A `links/10-code.json`: the one definition, which both checks the file and is the JSON Schema editors and the
 * pre-commit hook check it with (`server/pages/schemas.ts`).
 */
export const linkFileSchema = z
  .strictObject({
    label: z
      .string()
      .min(1)
      .max(MAX_LINK_LABEL)
      .regex(/^[^[\]]*$/)
      .refine((label) => label.trim() !== '' && !/\p{C}/u.test(label))
      .meta({
        description: `What the link says under the title, such as "Code" or "Video" (1 to ${MAX_LINK_LABEL} characters, no brackets). One named like a built-in link (arXiv, PDF, OpenReview, DOI, Scholar) replaces it.`,
      }),
    url: httpUrl(MAX_LINK_URL).meta({ description: 'Where it goes: an http or https address.' }),
  })
  .meta({
    title: 'Link',
    description:
      "A link shown under the paper's title. One file per link, named like 10-code.json; they show in the order of their names.",
  });

/** A link's problem, or `null`. Only http(s), so a link can't run anything. */
export function linkProblem(link: TitleLink): string | null {
  const label = link.label.trim();
  if (!linkFileSchema.shape.label.safeParse(label).success) {
    return `needs a label of 1 to ${MAX_LINK_LABEL} characters, without brackets or control characters`;
  }
  if (!linkFileSchema.shape.url.safeParse(link.url).success) return 'needs an http or https address';
  return null;
}

/** The link in a `links/10-code.json`, or `null` if it isn't a good one. */
export function parseLinkFile(text: string): TitleLink | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = linkFileSchema.safeParse(value);
  return parsed.success ? { label: parsed.data.label.trim(), url: parsed.data.url } : null;
}

export function encodeLinkFile({ label, url }: TitleLink): string {
  return `${JSON.stringify({ label, url }, null, 2)}\n`;
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
