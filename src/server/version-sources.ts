import type { Database } from '@/db';
import type { SubmissionStatus } from '@/lib/submissions';
import { normalizeTitle, type PaperVersion, type VersionKind, type VersionPdf } from '@/lib/versions';
import { fetchPdf } from './files';
import { forumUrl, licenseId, OPENREVIEW } from './venue-sources/openreview';

/**
 * Finding a paper's versions where they are published: its forums on OpenReview, one per venue it went to
 * (a workshop, then a conference), and its arXiv versions. What comes back is a suggestion: the editor shows
 * it to be checked and saved, and `scripts/import-versions.ts` commits it. The parsers are pure, for tests.
 */

export { normalizeTitle };

const USER_AGENT = 'PotentialPaper (+https://papers.potentialhedge.com)';
const TIMEOUT_MS = 20_000;

/** A found version: a version without an id, its PDF still at its source. */
export interface FoundVersion extends Omit<PaperVersion, 'id' | 'pdf'> {
  url: string;
  /** Where its PDF can be copied from, and the license that lets us (`null`: not copied). */
  pdfSource: string | null;
  license: string | null;
}

export interface OpenReviewSearchNote {
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

/** Trailing parts of a venue id that file a submission by its standing, not part of the venue's name. */
const STANDING_PART = /^(\w+_)?(Submissions?|Rejected|Withdrawn|Under_Review|Submitted|Retracted|Accepted)$/i;
const WORKSHOP_PART = /^(Workshop|Bridge|Symposium|Tutorial)s?$/i;

const spaced = (part: string) => part.replace(/_/g, ' ').trim();

/**
 * A venue's name and kind from its id, which is structured where the venue string is whatever the
 * organisers typed ("airrworkshop OralandPoster"): `ICLR.cc/2027/Conference` → "ICLR 2027",
 * `NeurIPS.cc/2025/Workshop/OPT` → "OPT @ NeurIPS 2025", `thecvf.com/CVPR/2026/Conference` → "CVPR 2026",
 * `NeurIPS.cc/2025/Datasets_and_Benchmarks_Track` → "NeurIPS 2025 Datasets and Benchmarks Track", `TMLR`.
 */
export function venueName(venueId: string): { label: string; kind: VersionKind; year: number | null } {
  const parts = venueId.split('/').filter(Boolean);
  while (parts.length > 1 && STANDING_PART.test(parts[parts.length - 1])) parts.pop();
  const at = parts.findIndex((part) => /^(19|20)\d\d$/.test(part));
  const journal = /Journal|^TMLR$|^JMLR$|^DMLR$/i.test(venueId);
  // A venue is not a kind of text: what goes to a workshop or a conference is a submitted version.
  const textKind: VersionKind = journal ? 'journal' : 'submitted';
  if (at === -1) return { label: spaced(parts.join(' ')), kind: textKind, year: null };
  const host = spaced((parts[at - 1] ?? parts[0]).replace(/\.(cc|org|com|net|io|ai|edu|info)$/i, ''));
  const year = Number(parts[at]);
  const base = `${host} ${year}`;
  const rest = parts.slice(at + 1).filter((part) => !/^Conference$/i.test(part));
  if (rest.length === 0) return { label: base, kind: textKind, year };
  if (WORKSHOP_PART.test(rest[0]) && rest.length > 1) {
    return { label: `${spaced(rest.slice(1).join(' '))} @ ${base}`, kind: textKind, year };
  }
  return { label: `${base} ${spaced(rest.join(' '))}`, kind: textKind, year };
}

const DECISION = /\b(Oral|Spotlight|Poster|Notable[\w -]*|Highlight|(?:Lightning |Contributed )?Talk)\s*$/i;

/**
 * A forum as a version of its paper: "SPIGM @ ICML Poster" filed under `ICML.cc/2026/Workshop/SPIGM` → an
 * accepted workshop submission, a poster. "ICLR 2027 Conference Submission" → under review (or, once its year is
 * past with no decision public, submitted with no status); "Submitted to ICLR 2026" → rejected. The decision goes
 * on the version's submission to the venue, not on the version.
 */
export function openReviewVersion(note: OpenReviewSearchNote, now = new Date()): FoundVersion | null {
  const venue = value(note, 'venue');
  const venueId = value(note, 'venueid');
  if (!venue || !venueId) return null;
  const { label, kind, year } = venueName(venueId);
  const standing = venueId.split('/').pop() ?? '';
  let status: SubmissionStatus | undefined;
  let decision: string | undefined;
  if (/Withdrawn/i.test(standing) || /\bwithdrawn\b/i.test(venue)) status = 'withdrawn';
  else if (/Desk_Rejected/i.test(standing) || /desk.rejected/i.test(venue)) status = 'desk_rejected';
  else if (/Rejected/i.test(standing) || /^Submitted to /i.test(venue) || /\brejected\b/i.test(venue)) {
    status = 'rejected';
  } else if (/(Submission|Under_Review|Submitted)$/i.test(standing) || /(Submission|under review)$/i.test(venue)) {
    // Once its year is past with no decision public, it is only known to have been submitted.
    status = year !== null && year < now.getUTCFullYear() ? undefined : 'under_review';
  } else {
    status = 'accepted';
    decision = DECISION.exec(venue)?.[1];
  }
  const forum = note.forum ?? note.id;
  const pdf = value(note, 'pdf');
  const title = value(note, 'title');
  const abstract = value(note, 'abstract');
  return {
    label,
    kind,
    date: isoDay(note.cdate ?? note.odate ?? note.pdate),
    submissions: [
      { venue: label, ...(status ? { status } : {}), ...(decision ? { decision } : {}), url: forumUrl(forum) },
    ],
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
    .map((note) => openReviewVersion(note))
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

/** The words of a text that say something, for telling two abstracts of one paper from two papers. */
const STOPWORDS = new Set(
  (
    'and the for with that this these those from into onto our are was were has have had not but can its their ' +
    'which while when where than then them they such also more most both each other over under between through ' +
    'via using based show shows shown propose proposed present new novel approach method methods model models ' +
    'results paper work task tasks data however further well across without within existing many large'
  ).split(' '),
);

function words(text: string): Set<string> {
  return new Set(
    normalizeTitle(text)
      .split(' ')
      .filter((word) => word.length > 2 && !STOPWORDS.has(word)),
  );
}

/**
 * How much two abstracts share, from 0 to 1 (Jaccard on their words). Versions of one paper are rewritten
 * but keep most of their words; two papers that happen to share a generic title don't.
 */
export function abstractOverlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / (x.size + y.size - shared);
}

/**
 * Whether a forum with a paper's exact title (normalized) is a version of it. Resubmissions often rewrite the
 * abstract from scratch, so a distinctive title needs little agreement; a short, generic one needs a lot.
 * `overlap` is `null` when either has no abstract.
 */
export function sameWork(title: string, overlap: number | null): boolean {
  const words = normalizeTitle(title).split(' ').filter(Boolean).length;
  if (overlap === null) return words >= 7;
  if (words >= 6) return overlap >= 0.03;
  if (words >= 3) return overlap >= 0.1;
  return overlap >= 0.25;
}
