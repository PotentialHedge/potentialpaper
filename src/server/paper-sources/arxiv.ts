import { XMLParser } from 'fast-xml-parser';
import { normalizeArxivId, parseDoi, type PaperId } from '@/lib/paper-ids';
import { CC0, fetchSource, SourceUnavailable, tidy, type PaperSource, type SourcePaper } from './types';

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === 'entry' || name === 'author',
});

interface AtomEntry {
  id?: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: { name?: string }[];
  'arxiv:doi'?: string;
  'arxiv:journal_ref'?: string;
}

/** The entry for `id` in an Atom feed from arXiv's API, or `null` if the feed has none. */
export function parseArxivFeed(xml: string, id: string): SourcePaper | null {
  let feed: { feed?: { entry?: AtomEntry[] } };
  try {
    feed = parser.parse(xml);
  } catch (err) {
    throw new SourceUnavailable(`arXiv sent bad XML: ${String(err)}`);
  }
  if (!feed.feed) throw new SourceUnavailable('arXiv sent something other than a feed');
  const entry = feed.feed.entry?.find((e) => normalizeArxivId(e.id?.replace(/^.*\/abs\//, '') ?? '') === id);
  if (!entry?.title) return null;

  const identifiers: PaperId[] = [{ scheme: 'arxiv', value: id }];
  const doi = entry['arxiv:doi'] ? parseDoi(entry['arxiv:doi']) : null;
  if (doi?.scheme === 'doi') identifiers.push(doi);
  const year = Number(entry.published?.slice(0, 4));
  const abstract = entry.summary ? tidy(entry.summary) || null : null;
  return {
    title: tidy(entry.title),
    authors: (entry.author ?? []).map((a) => tidy(a.name ?? '')).filter(Boolean),
    abstract,
    year: Number.isInteger(year) && year > 0 ? year : null,
    venue: entry['arxiv:journal_ref'] ? tidy(entry['arxiv:journal_ref']) : null,
    identifiers,
    source: 'arxiv',
    // arXiv's API terms: descriptive metadata, "title, abstract, authors, identifiers", is CC0.
    metadataLicense: CC0,
    abstractLicense: abstract ? CC0 : null,
  };
}

/** arXiv's metadata is CC0, abstracts included. Its API terms ask for at most one request every three seconds. */
export const arxivSource: PaperSource = {
  name: 'arxiv',
  budget: { burst: 1, perSecond: 1 / 3 },
  async fetch(id) {
    const res = await fetchSource(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
    return res && parseArxivFeed(await res.text(), id);
  },
};
