import type { Database } from '@/db';
import type { PaperVersion, VersionKind, VersionPdf, VersionStatus } from '@/lib/versions';
import { fetchPdf } from './files';
import { forumUrl, licenseId, OPENREVIEW } from './venue-sources/openreview';

/**
 * Finding a paper's versions where they are published: its forums on OpenReview, one per venue it went to
 * (a workshop, then a conference), and its arXiv versions. What comes back is a suggestion: the editor shows
 * it to be checked and saved, and `scripts/import-versions.ts` commits it. The parsers are pure, for tests.
 */

const USER_AGENT = 'PotentialPaper (+https://papers.potentialhedge.com)';
const TIMEOUT_MS = 20_000;

/** A found version: a version without an id, its PDF still at its source. */
export interface FoundVersion extends Omit<PaperVersion, 'id' | 'pdf'> {
  url: string;
  /** Where its PDF can be copied from, and the license that lets us (`null`: not copied). */
  pdfSource: string | null;
  license: string | null;
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

interface OpenReviewSearchNote {
  id: string;
  forum?: string;
  cdate?: number;
  pdate?: number;
  odate?: number;
  license?: string;
  content: Record<string, { value?: unknown } | undefined>;
}

const value = (note: OpenReviewSearchNote, key: string): string | null => {
  const v = note.content[key]?.value;
  return typeof v === 'string' ? v : null;
};

const isoDay = (ms: number | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : undefined);

/**
 * "SPIGM @ ICML Poster" filed under `ICML.cc/2026/Workshop/SPIGM` → an accepted workshop version, a
 * poster. "ICLR 2027 Conference Submission" → under review; "Submitted to ICLR 2026" → not accepted.
 */
export function openReviewVersion(note: OpenReviewSearchNote): FoundVersion | null {
  const venue = value(note, 'venue');
  const venueId = value(note, 'venueid');
  if (!venue || !venueId) return null;
  const workshop = /\/Workshop\//i.test(venueId);
  const kind: VersionKind = workshop ? 'workshop' : /\/Journal|TMLR|JMLR/i.test(venueId) ? 'journal' : 'conference';
  const group = venueId.split('/').pop() ?? '';
  let status: VersionStatus | undefined;
  let decision: string | undefined;
  if (/Withdrawn/i.test(group) || /withdrawn/i.test(venue)) status = 'withdrawn';
  else if (/Desk_Rejected|Rejected/i.test(group) || /rejected/i.test(venue)) status = 'rejected';
  else if (/^Submitted to /i.test(venue)) status = 'rejected';
  else if (/Submission$/i.test(group) || /Submission$/i.test(venue)) status = 'under_review';
  else {
    status = 'accepted';
    decision = /\b(Oral|Spotlight|Poster|Notable[\w -]*|Highlight)\s*$/i.exec(venue)?.[1];
  }
  // The venue as it names itself, without the decision: "SPIGM @ ICML", "ICLR 2027 Conference".
  const label = venue
    .replace(/^Submitted to /i, '')
    .replace(/\s+(Conference\s+)?(Withdrawn\s+|Desk\s+Rejected\s+)?Submission$/i, (_, conf) =>
      conf ? ' Conference' : '',
    )
    .replace(/\s+(Oral|Spotlight|Poster|Notable[\w -]*|Highlight)\s*$/i, '')
    .trim();
  const year = /\/(\d{4})\//.exec(venueId)?.[1];
  const named = year && !label.includes(year) ? `${label} ${year}` : label;
  const forum = note.forum ?? note.id;
  const pdf = value(note, 'pdf');
  const title = value(note, 'title');
  const abstract = value(note, 'abstract');
  return {
    label: named,
    kind,
    date: isoDay(note.cdate ?? note.odate ?? note.pdate),
    status,
    ...(decision ? { decision } : {}),
    ...(title ? { title: title.trim() } : {}),
    ...(abstract ? { abstract: abstract.trim() } : {}),
    url: forumUrl(forum),
    pdfSource: pdf ? new URL(pdf, OPENREVIEW).toString() : null,
    license: note.license ? licenseId(note.license) : null,
    evidence: [forumUrl(forum)],
  };
}

/** The forums on OpenReview with this exact title (any venue), as versions. */
export async function openReviewVersions(title: string): Promise<FoundVersion[]> {
  const query = new URLSearchParams({ term: title, type: 'terms', content: 'all', source: 'forum', limit: '50' });
  const res = await fetch(`https://api2.openreview.net/notes/search?${query}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenReview search: HTTP ${res.status}`);
  const { notes = [] } = (await res.json()) as { notes?: OpenReviewSearchNote[] };
  const wanted = normalizeTitle(title);
  return notes
    .filter((note) => normalizeTitle(value(note, 'title') ?? '') === wanted)
    .map(openReviewVersion)
    .filter((v): v is FoundVersion => v !== null);
}

const MONTHS: Record<string, string> = {
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
};

/** "http://creativecommons.org/licenses/by/4.0/" → `CC-BY-4.0`; `null` for arXiv's own license. */
export function arxivLicense(url: string | null): string | null {
  if (!url) return null;
  if (/publicdomain\/zero/i.test(url)) return 'CC0-1.0';
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/(\d\.\d)/i.exec(url);
  return cc ? `CC-${cc[1].toUpperCase()}-${cc[2]}` : null;
}

/**
 * The versions in an arXiv abstract page's submission history: `[v1] Tue, 16 Jun 2026 15:02:49 UTC`.
 * Its PDF is copied only under a Creative Commons license: arXiv's own doesn't let us host it.
 */
export function parseArxivHistory(html: string, id: string): FoundVersion[] {
  const license = arxivLicense(/class="abs-license"[\s\S]*?href="([^"]+)"/.exec(html)?.[1] ?? null);
  const found: FoundVersion[] = [];
  const entry = /\[v(\d+)\](?:<\/a>)?<\/strong>\s*\w{3},\s*(\d{1,2})\s+(\w{3})\s+(\d{4})/g;
  for (const match of html.matchAll(entry)) {
    const [, n, day, month, year] = match;
    const url = `https://arxiv.org/abs/${id}v${n}`;
    found.push({
      label: `arXiv v${n}`,
      kind: 'preprint',
      date: `${year}-${MONTHS[month] ?? '01'}-${day.padStart(2, '0')}`,
      status: 'published',
      url,
      pdfSource: license ? `https://arxiv.org/pdf/${id}v${n}` : null,
      license,
      evidence: [url],
    });
  }
  return found;
}

export async function arxivVersions(id: string): Promise<FoundVersion[]> {
  const res = await fetch(`https://arxiv.org/abs/${encodeURIComponent(id)}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`arXiv: HTTP ${res.status}`);
  return parseArxivHistory(await res.text(), id.replace(/v\d+$/, ''));
}

/** Finds an arXiv id for a title through arXiv's API: the exact title, or nothing. */
export async function arxivIdForTitle(title: string): Promise<string | null> {
  const query = new URLSearchParams({ search_query: `ti:"${title.replace(/"/g, '')}"`, max_results: '5' });
  const res = await fetch(`https://export.arxiv.org/api/query?${query}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const xml = await res.text();
  const wanted = normalizeTitle(title);
  for (const entry of xml.split('<entry>').slice(1)) {
    const entryTitle = /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? '';
    const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<]+?)(v\d+)?<\/id>/.exec(entry)?.[1];
    if (id && normalizeTitle(entryTitle.replace(/\s+/g, ' ')) === wanted) return id;
  }
  return null;
}

export interface LookupResult {
  versions: (Omit<FoundVersion, 'pdfSource' | 'license'> & { pdf?: VersionPdf })[];
  /** What couldn't be reached or copied, to show beside the suggestion. */
  problems: string[];
}

/**
 * Looks a paper up on OpenReview and arXiv, and copies each version's PDF here where its license lets us and
 * the source lets us fetch it. `known` is the PDF for a forum we already host (the page's own).
 */
export async function lookUpVersions(
  input: { title: string; arxiv?: string | null; accountId: string | null; known?: Map<string, VersionPdf> },
  database?: Database,
): Promise<LookupResult> {
  const problems: string[] = [];
  const found: FoundVersion[] = [];
  const [openreview, arxivId] = await Promise.all([
    openReviewVersions(input.title).catch((err) => (problems.push(`OpenReview: ${String(err.message ?? err)}`), [])),
    input.arxiv ? Promise.resolve(input.arxiv) : arxivIdForTitle(input.title).catch(() => null),
  ]);
  found.push(...openreview);
  if (arxivId) {
    found.push(
      ...(await arxivVersions(arxivId).catch((err) => (problems.push(`arXiv: ${String(err.message ?? err)}`), []))),
    );
  }
  const versions: LookupResult['versions'] = [];
  for (const { pdfSource, license, ...version } of found) {
    let pdf = input.known?.get(version.url);
    if (!pdf && pdfSource && license) {
      try {
        const file = await fetchPdf(input.accountId, pdfSource, database);
        pdf = { sha256: file.sha256, bytes: file.bytes, url: file.url, source: pdfSource, license };
      } catch (err) {
        problems.push(`${version.label}: could not copy the PDF (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    versions.push({ ...version, ...(pdf ? { pdf } : {}) });
  }
  return { versions, problems };
}
