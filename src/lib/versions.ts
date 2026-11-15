/**
 * The versions of a paper: a preprint, its workshop and conference submissions, the camera-ready, a journal
 * version. A paper is one work (DESIGN.md §3), and each version is a file of the page's repo,
 * `versions/<id>.json`, so they get history, diffs, revert and blame like the rest of the page. Each can carry its own PDF, which
 * is how two versions are compared, and the evidence that it is what it says.
 *
 * Pure, so the server, the editor and the tests share it.
 */
import { evidenceProblem, MAX_EVIDENCE } from './evidence';

export const VERSION_KINDS = ['preprint', 'workshop', 'conference', 'journal', 'camera-ready', 'other'] as const;
export type VersionKind = (typeof VERSION_KINDS)[number];

export const VERSION_KIND_LABELS: Record<VersionKind, string> = {
  preprint: 'Preprint',
  workshop: 'Workshop',
  conference: 'Conference',
  journal: 'Journal',
  'camera-ready': 'Camera-ready',
  other: 'Other',
};

export const VERSION_STATUSES = [
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'withdrawn',
  'published',
] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

export const VERSION_STATUS_LABELS: Record<VersionStatus, string> = {
  submitted: 'Submitted',
  under_review: 'Under review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  published: 'Published',
};

/**
 * A version's PDF, hosted here by its SHA-256 as the page's own is. In the repo it is two things: the PDF
 * itself beside the version's file, `versions/<id>.pdf` (a Git LFS pointer, which has the hash and size), and
 * the rest in the version's file as `"pdf": { "source", "license" }` (`VersionPdfInfo`).
 */
export interface VersionPdf {
  sha256: string;
  bytes: number;
  url: string;
  /** Where it was copied from, when it was copied rather than uploaded. */
  source?: string;
  license?: string;
}

/** What a version's file says about its PDF. */
export type VersionPdfInfo = Pick<VersionPdf, 'source' | 'license'>;

export interface PaperVersion {
  /** Stable, so the compare page's links keep working when versions are added or reordered. */
  id: string;
  /** What the version is: "ICML 2026 Workshop on Structured Probabilistic Inference", "arXiv v2". */
  label: string;
  kind: VersionKind;
  /** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`: when it was submitted, or made public. */
  date?: string;
  status?: VersionStatus;
  /** As the venue words it: "Poster", "Oral", "Accept (Spotlight)". */
  decision?: string;
  /** The title it had, when not the paper's. */
  title?: string;
  abstract?: string;
  /** Where the version is: its forum, its arXiv page, its proceedings page. */
  url?: string;
  pdf?: VersionPdf;
  /** What changed from the version before, in a sentence or two. */
  note?: string;
  /** Addresses that back it up (`lib/evidence.ts`). */
  evidence?: string[];
}

export const MAX_VERSIONS = 50;
export const MAX_VERSION_LABEL = 160;
export const MAX_VERSION_DECISION = 120;
export const MAX_VERSION_TITLE = 400;
export const MAX_VERSION_ABSTRACT = 6000;
export const MAX_VERSION_NOTE = 2000;
const MAX_URL = 2000;

/**
 * A version's id, which is also its file's name. Ids made here look like `v_k3x9q2ab`; a person adding a
 * file by hand may name it as they like within this.
 */
export const VERSION_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

function httpsProblem(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > MAX_URL) return true;
  const url = URL.parse(value);
  return !url || (url.protocol !== 'https:' && url.protocol !== 'http:');
}

function textProblem(value: unknown, max: number): boolean {
  return (
    typeof value !== 'string' || value.trim() === '' || value.length > max || /\p{Cc}/u.test(value.replace(/\n/g, ''))
  );
}

function pdfProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'has a PDF that is not an object';
  const { sha256, bytes, url, source, license } = value as Partial<VersionPdf>;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return 'has a PDF without a SHA-256';
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) return 'has a PDF without its size';
  const hosted = typeof url === 'string' && (/^\/[^/\\]/.test(url) || URL.parse(url)?.protocol === 'https:');
  if (!hosted) return 'has a PDF without an address';
  if (source !== undefined && httpsProblem(source)) return 'has a PDF with a bad source';
  if (license !== undefined && textProblem(license, 100)) return 'has a PDF with a bad license';
  return null;
}

const FIELDS = new Set([
  'id',
  'label',
  'kind',
  'date',
  'status',
  'decision',
  'title',
  'abstract',
  'url',
  'pdf',
  'note',
  'evidence',
]);

/** A version's problem, or `null`. */
export function versionProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'is not an object';
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!FIELDS.has(key)) return `has an unknown field “${key}”`;
  if (typeof v.id !== 'string' || !VERSION_ID.test(v.id)) return 'needs an id like v_k3x9q2ab';
  if (textProblem(v.label, MAX_VERSION_LABEL)) return `needs a label of 1 to ${MAX_VERSION_LABEL} characters`;
  if (!VERSION_KINDS.includes(v.kind as VersionKind)) return `needs a kind: ${VERSION_KINDS.join(', ')}`;
  if (v.date !== undefined && (typeof v.date !== 'string' || !DATE.test(v.date))) {
    return 'needs a date as YYYY, YYYY-MM or YYYY-MM-DD';
  }
  if (v.status !== undefined && !VERSION_STATUSES.includes(v.status as VersionStatus)) {
    return `needs a status: ${VERSION_STATUSES.join(', ')}`;
  }
  if (v.decision !== undefined && textProblem(v.decision, MAX_VERSION_DECISION)) return 'has a bad decision';
  if (v.title !== undefined && textProblem(v.title, MAX_VERSION_TITLE)) return 'has a bad title';
  if (v.abstract !== undefined && textProblem(v.abstract, MAX_VERSION_ABSTRACT)) return 'has a bad abstract';
  if (v.note !== undefined && textProblem(v.note, MAX_VERSION_NOTE)) return 'has a bad note';
  if (v.url !== undefined && httpsProblem(v.url)) return 'needs an http or https address';
  if (v.pdf !== undefined) {
    const problem = pdfProblem(v.pdf);
    if (problem) return problem;
  }
  if (v.evidence !== undefined) {
    if (!Array.isArray(v.evidence) || v.evidence.length > MAX_EVIDENCE) {
      return `has more than ${MAX_EVIDENCE} pieces of evidence`;
    }
    for (const url of v.evidence) {
      const problem = typeof url === 'string' ? evidenceProblem(url) : 'is not an address';
      if (problem) return `has evidence that ${problem}`;
    }
  }
  return null;
}

function pdfInfoProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'has a “pdf” that is not an object';
  for (const key of Object.keys(value)) {
    if (key !== 'source' && key !== 'license') {
      return `has “pdf.${key}”; the PDF itself is versions/<id>.pdf, and “pdf” only says its “source” and “license”`;
    }
  }
  const { source, license } = value as VersionPdfInfo;
  if (source !== undefined && httpsProblem(source)) return 'has a PDF with a bad source';
  if (license !== undefined && textProblem(license, 100)) return 'has a PDF with a bad license';
  return null;
}

/**
 * The version in `versions/<id>.json`, without its PDF, and what the file says about the PDF; or why it
 * isn't one. The id is the file's name, not a field. The PDF itself is `versions/<id>.pdf`.
 */
export function parseVersionFile(
  id: string,
  text: string,
): { version: PaperVersion; pdfInfo: VersionPdfInfo } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'is not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { problem: 'is not a JSON object' };
  if ('id' in value) return { problem: 'takes its id from its file name, so leave “id” out' };
  const { pdf, ...rest } = value as Record<string, unknown>;
  if (pdf !== undefined) {
    const problem = pdfInfoProblem(pdf);
    if (problem) return { problem };
  }
  const version = { id, ...rest } as PaperVersion;
  const problem = versionProblem(version);
  if (problem) return { problem };
  const { source, license } = (pdf ?? {}) as VersionPdfInfo;
  return { version, pdfInfo: { ...(source ? { source } : {}), ...(license ? { license } : {}) } };
}

/** Fields in a fixed order, so that a file only changes where the version does. The id is the file's name. */
const ORDER: (keyof PaperVersion)[] = [
  'date',
  'kind',
  'label',
  'status',
  'decision',
  'title',
  'url',
  'pdf',
  'evidence',
  'note',
  'abstract',
];

/**
 * A version's file: a field to a line, so two people changing different fields of it merge. Of its PDF only
 * the source and license, as the PDF is a file of its own (`versions/<id>.pdf`).
 */
export function encodeVersionFile(version: PaperVersion): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ORDER) {
    if (key === 'pdf') {
      const { source, license } = version.pdf ?? {};
      if (source || license) ordered.pdf = { ...(source ? { source } : {}), ...(license ? { license } : {}) };
    } else if (version[key] !== undefined) {
      ordered[key] = version[key];
    }
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Oldest first; undated versions last, in the order they were given. */
export function sortVersions<T extends Pick<PaperVersion, 'date'>>(versions: readonly T[]): T[] {
  return versions
    .map((version, index) => ({ version, index }))
    .sort((a, b) => {
      const x = a.version.date ?? '9999';
      const y = b.version.date ?? '9999';
      return x < y ? -1 : x > y ? 1 : a.index - b.index;
    })
    .map(({ version }) => version);
}

/** "Accepted · Poster", "Under review", or `null`. */
export function versionStanding(version: Pick<PaperVersion, 'status' | 'decision'>): string | null {
  const status = version.status ? VERSION_STATUS_LABELS[version.status] : null;
  // "Accept (Oral)" already says accepted.
  const stem = status
    ?.toLowerCase()
    .replace(/(ed|n)$/, '')
    .slice(0, 6);
  if (status && version.decision && !version.decision.toLowerCase().includes(stem!)) {
    return `${status} · ${version.decision}`;
  }
  return version.decision ?? status;
}

/** "14 Jun 2026", "Jun 2026" or "2026". */
export function formatVersionDate(date: string | undefined): string | null {
  if (!date) return null;
  const [year, month, day] = date.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (!month) return String(year);
  if (!day) return `${months[month - 1]} ${year}`;
  return `${day} ${months[month - 1]} ${year}`;
}

const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** A new version's id. Random, so two people adding versions at once don't collide. */
export function newVersionId(random: () => number = Math.random): string {
  let id = 'v_';
  for (let i = 0; i < 8; i += 1) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)];
  return id;
}

/** A title as matched across venues: accents, case and punctuation dropped. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
