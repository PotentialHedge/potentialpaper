import { XMLParser } from 'fast-xml-parser';
import { normalizeArxivId, parseDoi, type PaperId } from '@/lib/paper-ids';
import { MAX_VENUE, MAX_VERSION_LABEL } from '@/lib/versions';
import {
  CC0,
  fetchSource,
  SourceUnavailable,
  tidy,
  type PaperSource,
  type SourcePaper,
  type SourceVersion,
} from './types';

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
  updated?: string;
  author?: { name?: string }[];
  'arxiv:doi'?: string;
  'arxiv:journal_ref'?: string;
}

/**
 * The versions an entry tells of: v1 when it was published, and the newest when it was last updated. The feed
 * dates no version in between, so those wait for whoever knows them (`import-versions`).
 */
function arxivVersions(entry: AtomEntry, id: string): SourceVersion[] {
  const latest = Number(/v(\d+)$/.exec(entry.id ?? '')?.[1] ?? 1);
  const day = (time?: string) => (time && /^\d{4}-\d{2}-\d{2}/.test(time) ? time.slice(0, 10) : undefined);
  const version = (n: number, date?: string): SourceVersion => ({
    label: `arXiv v${n}`,
    kind: 'preprint',
    date,
    url: `https://arxiv.org/abs/${id}v${n}`,
  });
  const versions = [version(1, day(entry.published))];
  if (latest > 1) versions.push(version(latest, day(entry.updated)));
  // Where the authors say it was published: "Phys. Rev. D 76, 013009 (2007)". Undated, so it sorts last.
  const journal = entry['arxiv:journal_ref'] ? tidy(entry['arxiv:journal_ref']).slice(0, MAX_VENUE) : '';
  if (journal) {
    versions.push({
      label: journal.slice(0, MAX_VERSION_LABEL),
      kind: 'journal',
      submissions: [{ venue: journal, status: 'accepted' }],
    });
  }
  return versions;
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
  const abstract = entry.summary ? tidy(entry.summary) || null : null;
  return {
    title: tidy(entry.title),
    authors: (entry.author ?? []).map((a) => tidy(a.name ?? '')).filter(Boolean),
    abstract,
    identifiers,
    source: 'arxiv',
    // arXiv's API terms: descriptive metadata, "title, abstract, authors, identifiers", is CC0.
    metadataLicense: CC0,
    abstractLicense: abstract ? CC0 : null,
    versions: arxivVersions(entry, id),
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
