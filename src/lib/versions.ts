/**
 * The versions of a paper: a preprint, its workshop and conference submissions, the camera-ready, a journal
 * version. A paper is one work (DESIGN.md §3), and each version is a file of the page's repo,
 * `versions/<id>.json`, so they get history, diffs, revert and blame like the rest of the page. Each can carry its own PDF, which
 * is how two versions are compared, and the evidence that it is what it says.
 *
 * Pure, so the server, the editor and the tests share it.
 */
import { z } from 'zod';
import { evidenceProblem, MAX_EVIDENCE } from './evidence';
import { httpUrl } from './paper-links';

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

/** Free text: not blank, and no control characters but newlines. */
function text(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() !== '' && !/\p{Cc}/u.test(value.replace(/\n/g, '')));
}

const evidenceSchema = z
  .array(
    z.string().superRefine((url, ctx) => {
      const problem = evidenceProblem(url);
      if (problem) ctx.addIssue({ code: 'custom', message: `has evidence that ${problem}` });
    }),
  )
  .max(MAX_EVIDENCE, { error: `has more than ${MAX_EVIDENCE} pieces of evidence` })
  .meta({
    description: `Up to ${MAX_EVIDENCE} https addresses (or files uploaded here) that back the version up: its forum, the venue's list of accepted papers.`,
  });

/** What a version is, as its file and the site both have it, but for its id and PDF. */
const versionShape = {
  label: text(MAX_VERSION_LABEL).meta({
    description: 'What the version is: "ICML 2026 Workshop on Structured Probabilistic Inference", "arXiv v2".',
  }),
  kind: z.enum(VERSION_KINDS).meta({ description: 'What kind of version it is.' }),
  date: z
    .string()
    .regex(DATE)
    .optional()
    .meta({ description: 'When it was submitted, or made public: YYYY, YYYY-MM or YYYY-MM-DD.' }),
  status: z.enum(VERSION_STATUSES).optional().meta({ description: 'Where it stands at its venue.' }),
  decision: text(MAX_VERSION_DECISION)
    .optional()
    .meta({ description: 'The decision as the venue words it: "Poster", "Oral", "Accept (Spotlight)".' }),
  title: text(MAX_VERSION_TITLE).optional().meta({ description: "The title it had, when not the paper's." }),
  abstract: text(MAX_VERSION_ABSTRACT).optional().meta({ description: "Its abstract, when not the paper's." }),
  url: httpUrl(MAX_URL)
    .optional()
    .meta({ description: 'Where the version is: its forum, its arXiv page, its proceedings page.' }),
  note: text(MAX_VERSION_NOTE)
    .optional()
    .meta({ description: 'What changed from the version before, in a sentence or two.' }),
  evidence: evidenceSchema.optional(),
};

/** What each field's problem is called, so a refusal says what to fix rather than how the check failed. */
const FIELD_PROBLEMS: Record<string, string> = {
  id: 'needs an id like v_k3x9q2ab',
  label: `needs a label of 1 to ${MAX_VERSION_LABEL} characters`,
  kind: `needs a kind: ${VERSION_KINDS.join(', ')}`,
  date: 'needs a date as YYYY, YYYY-MM or YYYY-MM-DD',
  status: `needs a status: ${VERSION_STATUSES.join(', ')}`,
  decision: 'has a bad decision',
  title: 'has a bad title',
  abstract: 'has a bad abstract',
  note: 'has a bad note',
  url: 'needs an http or https address',
};

const PDF_PROBLEMS: Record<string, string> = {
  sha256: 'has a PDF without a SHA-256',
  bytes: 'has a PDF without its size',
  url: 'has a PDF without an address',
  source: 'has a PDF with a bad source',
  license: 'has a PDF with a bad license',
};

function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  const [field, sub] = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') {
    return field === 'pdf'
      ? `has “pdf.${issue.keys[0]}”; the PDF itself is versions/<id>.pdf, and “pdf” only says its “source” and “license”`
      : `has an unknown field “${issue.keys[0]}”`;
  }
  if (field === undefined) return 'is not an object';
  if (field === 'pdf') return (sub && PDF_PROBLEMS[sub]) ?? 'has a “pdf” that is not an object';
  if (field === 'evidence')
    return issue.code === 'custom' || issue.code === 'too_big' ? issue.message : 'has evidence that is not an address';
  return FIELD_PROBLEMS[field] ?? issue.message;
}

const pdfSourceShape = {
  source: httpUrl(MAX_URL).optional().meta({ description: 'Where the PDF was copied from.' }),
  license: text(100).optional().meta({ description: 'The license it was copied under, such as "CC BY 4.0".' }),
};

/** A version as the site holds it: with its id, and its PDF where it is hosted. */
const paperVersionSchema = z.strictObject({
  id: z.string().regex(VERSION_ID),
  ...versionShape,
  pdf: z
    .strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().positive(),
      url: z.string().refine((url) => /^\/[^/\\]/.test(url) || URL.parse(url)?.protocol === 'https:'),
      ...pdfSourceShape,
    })
    .optional(),
});

/**
 * A `versions/<id>.json`: the one definition, which both checks the file and is the JSON Schema editors and the
 * pre-commit hook check it with (`server/pages/schemas.ts`). The id is the file's name; the PDF is the file beside
 * it, `versions/<id>.pdf`, and `pdf` only says where it came from.
 */
export const versionFileSchema = z
  .strictObject({
    ...versionShape,
    pdf: z
      .strictObject(pdfSourceShape)
      .optional()
      .meta({ description: 'Where versions/<id>.pdf, beside this file, came from: needed when it was copied.' }),
  })
  .meta({
    title: 'Version',
    description:
      "A version of the paper: a preprint, a submission, the camera-ready. The file's name is its id, like v_k3x9q2ab.json.",
  });

/** A version's problem, or `null`. */
export function versionProblem(value: unknown): string | null {
  const parsed = paperVersionSchema.safeParse(value);
  return parsed.success ? null : firstProblem(parsed.error);
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
  if (!VERSION_ID.test(id)) return { problem: FIELD_PROBLEMS.id };
  const parsed = versionFileSchema.safeParse(value);
  if (!parsed.success) return { problem: firstProblem(parsed.error) };
  const { pdf, ...rest } = value as Record<string, unknown>;
  const version = { id, ...rest } as PaperVersion;
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
