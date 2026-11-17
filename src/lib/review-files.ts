import { z } from 'zod';
import { VERSION_ID } from './versions';
import {
  type FieldValue,
  NOTE_KINDS,
  type NoteKind,
  SUBMISSION_STATUSES,
  type SubmissionStatus,
  type VenueForms,
} from './submissions';

/**
 * A venue's submissions and what it published about them, as files in the paper's repo (DESIGN.md §3, §4.3,
 * §4.8), written only by the bot granted their source (`rules.ts`):
 *
 *   reviews/<source>/<submission>/submission.json   the submission: venue, status, decision, link
 *   reviews/<source>/<submission>/forms.json        the venue's forms, which say how to show its notes
 *   reviews/<source>/<submission>/notes/<id>.json   one review, meta-review, decision or comment
 *
 * `<source>` is the bot's source (`openreview`); `<submission>` and a note's `<id>` are the source's ids,
 * lower-cased, since a clone on a Mac or Windows can't hold two names that differ only in case. The ids as the
 * source spells them are inside the files. Each file names its shape (`"schema": "review/1"`): a new shape is a
 * new schema beside the old, so files already committed never need migrating. Each carries its license and
 * the address it came from, as OpenReview's CC BY 4.0 asks of every note shown (DESIGN.md §3).
 *
 * What changes on every import (when it was read) is left out, so a re-import that finds nothing new
 * changes no file and commits nothing; the commit's time says when a change was seen.
 */

export const REVIEWS_DIR = 'reviews';

/** A source's name: a lower-case slug, as a bot's grant names it (`reviews/openreview/**`). */
export const REVIEW_SOURCE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SOURCE = 40;
/** A submission's or note's folder or file name: the source's id, lower-cased. */
export const REVIEW_ID_SLUG = /^[a-z0-9_-]+$/;
const MAX_ID_SLUG = 100;

export const SUBMISSION_FILE = 'submission.json';
export const FORMS_FILE = 'forms.json';
export const NOTES_DIR = 'notes';

export type ReviewFileKind = 'submission' | 'forms' | 'note';

export interface ReviewPath {
  source: string;
  /** The submission's folder name. */
  submission: string;
  kind: ReviewFileKind;
  /** A note's file name, without `.json`. */
  note?: string;
}

const slug = (value: string, pattern: RegExp, max: number) => pattern.test(value) && value.length <= max;

/** What a path under `reviews/` is, or `null` if it is none of the three files. */
export function parseReviewPath(path: string): ReviewPath | null {
  const parts = path.split('/');
  if (parts[0] !== REVIEWS_DIR || parts.length < 4) return null;
  const [, source, submission, ...rest] = parts;
  if (!slug(source, REVIEW_SOURCE, MAX_SOURCE) || !slug(submission, REVIEW_ID_SLUG, MAX_ID_SLUG)) return null;
  if (rest.length === 1 && rest[0] === SUBMISSION_FILE) return { source, submission, kind: 'submission' };
  if (rest.length === 1 && rest[0] === FORMS_FILE) return { source, submission, kind: 'forms' };
  if (rest.length === 2 && rest[0] === NOTES_DIR && rest[1].endsWith('.json')) {
    const note = rest[1].slice(0, -'.json'.length);
    if (slug(note, REVIEW_ID_SLUG, MAX_ID_SLUG)) return { source, submission, kind: 'note', note };
  }
  return null;
}

/** The source a path under `reviews/` belongs to, valid or not, or `null`. */
export function reviewSourceOf(path: string): string | null {
  const match = /^reviews\/([^/]+)(?:\/|$)/.exec(path);
  return match ? match[1] : null;
}

/** The folder name for a source's id: lower case. */
export function reviewSlug(id: string): string {
  return id.toLowerCase();
}

export function submissionDir(source: string, submissionId: string): string {
  return `${REVIEWS_DIR}/${source}/${reviewSlug(submissionId)}`;
}

export function submissionFilePath(source: string, submissionId: string): string {
  return `${submissionDir(source, submissionId)}/${SUBMISSION_FILE}`;
}

export function formsFilePath(source: string, submissionId: string): string {
  return `${submissionDir(source, submissionId)}/${FORMS_FILE}`;
}

export function noteFilePath(source: string, submissionId: string, noteId: string): string {
  return `${submissionDir(source, submissionId)}/${NOTES_DIR}/${reviewSlug(noteId)}.json`;
}

export const SUBMISSION_SCHEMA = 'submission/1';
export const FORMS_SCHEMA = 'forms/1';
export const NOTE_SCHEMA = 'review/1';

const MAX_SHORT = 500;
const MAX_URL = 2000;

const shortText = (max = MAX_SHORT) => z.string().min(1).max(max);
const httpsUrl = z
  .string()
  .max(MAX_URL)
  .refine((value) => URL.parse(value)?.protocol === 'https:', { message: 'needs an https address' })
  .meta({ format: 'uri' });
const license = shortText(100).meta({
  description:
    'The license it is published under: an SPDX id where there is one ("CC-BY-4.0"), else the source\'s own words.',
});
const timestamp = z.iso.datetime({ offset: true });

const fieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const fieldSpecSchema = z.strictObject({
  key: shortText(200).meta({ description: 'The field, as the note\'s "content" names it.' }),
  label: shortText(200).meta({ description: 'What the page calls it.' }),
  type: z
    .enum(['score', 'choice', 'text'])
    .optional()
    .meta({ description: 'score: a number, averaged across reviews; choice: a short answer; text: a passage.' }),
  min: z.number().optional().meta({ description: "A score's lowest value, where the venue states it." }),
  max: z.number().optional().meta({ description: "A score's highest value, where the venue states it." }),
  hidden: z.boolean().optional().meta({ description: 'Not shown: boilerplate such as a code-of-conduct box.' }),
  omitWhen: z
    .array(z.string())
    .optional()
    .meta({ description: 'Not shown when it says one of these, the answer nearly every note gives.' }),
});

const noteFormSchema = z.strictObject({
  label: shortText(200).meta({ description: 'What this kind of note is called: "Official review".' }),
  fields: z.array(fieldSpecSchema).meta({ description: 'How to show its fields, in this order.' }),
  summary: z
    .array(z.string())
    .optional()
    .meta({ description: "The scores in the submission's summary table, in order. Left out: every score." }),
});

/** As many keywords as a submission keeps. */
export const MAX_KEYWORDS = 30;

/** A `reviews/<source>/<submission>/submission.json`. */
export const submissionFileSchema = z
  .strictObject({
    schema: z.literal(SUBMISSION_SCHEMA).meta({ description: `The shape of this file: "${SUBMISSION_SCHEMA}".` }),
    id: shortText(200).meta({ description: "The source's id for the submission, such as an OpenReview forum id." }),
    venue: z
      .strictObject({
        id: shortText(200).meta({ description: 'The source\'s id for the venue: "ICLR.cc/2027/Conference".' }),
        name: shortText(200).meta({ description: 'The venue as people say it: "ICLR 2027".' }),
        url: httpsUrl.nullable().meta({ description: "The venue's page at the source." }),
      })
      .meta({ description: 'Where it was submitted.' }),
    number: z.number().int().nullable().meta({ description: "The submission's number at the venue, if it has one." }),
    status: z
      .enum(SUBMISSION_STATUSES)
      .nullable()
      .meta({ description: `Where it stands: ${SUBMISSION_STATUSES.join(', ')}; null when the source doesn't say.` }),
    decision: shortText().nullable().meta({ description: 'The decision as the venue words it: "Accept (Poster)".' }),
    keywords: z
      .array(shortText(200))
      .max(MAX_KEYWORDS)
      .optional()
      .meta({
        description: 'The keywords its authors gave the source, as they wrote them. Topic suggestions match them.',
      }),
    version: z
      .string()
      .regex(VERSION_ID)
      .optional()
      .meta({ description: 'The version of the paper it is, as versions/<id>.json names it.' }),
    url: httpsUrl.meta({ description: 'Where it is at the source, linked from its credit.' }),
    license,
  })
  .meta({
    title: 'Submission',
    description:
      "A submission of the paper to a venue, imported by the bot granted reviews/<source>/. Its notes are in notes/ beside it, and the venue's forms in forms.json.",
  });

/** A `reviews/<source>/<submission>/forms.json`. */
export const formsFileSchema = z
  .strictObject({
    schema: z.literal(FORMS_SCHEMA).meta({ description: `The shape of this file: "${FORMS_SCHEMA}".` }),
    forms: z
      .record(z.string().min(1).max(200), noteFormSchema)
      .meta({ description: 'How to show each kind of note, by the source\'s name for it: "Official_Review".' }),
    url: httpsUrl.meta({ description: 'Where the forms come from at the source.' }),
    license,
  })
  .meta({
    title: 'Venue forms',
    description:
      "How the venue's notes are shown: labels, field order, score ranges and summary columns. A field no form names is shown by what its value looks like.",
  });

/** A `reviews/<source>/<submission>/notes/<id>.json`. */
export const noteFileSchema = z
  .strictObject({
    schema: z.literal(NOTE_SCHEMA).meta({ description: `The shape of this file: "${NOTE_SCHEMA}".` }),
    id: shortText(200).meta({ description: "The source's id for the note; the file is named by it, lower-cased." }),
    replyTo: shortText(200)
      .nullable()
      .meta({ description: 'The id of the note it answers; null when it answers the submission.' }),
    kind: z.enum(NOTE_KINDS).meta({ description: `What it is: ${NOTE_KINDS.join(', ')}.` }),
    invitation: shortText(200).meta({
      description: 'The source\'s name for its kind, which picks its form in forms.json: "Official_Review".',
    }),
    signature: shortText(200).meta({ description: 'Who wrote it, as the venue shows them: "Reviewer B3x7".' }),
    content: z
      .record(z.string().min(1).max(200), fieldValueSchema)
      .meta({ description: 'Its fields as the venue gave them: text, numbers, yes/no, or lists of text.' }),
    createdAt: timestamp.meta({ description: 'When it was posted (ISO 8601, with its offset).' }),
    modifiedAt: timestamp.nullable().optional().meta({ description: 'When it was last changed at the source.' }),
    url: httpsUrl.meta({ description: 'Where it is at the source, linked from its credit.' }),
    license,
  })
  .meta({
    title: 'Review',
    description:
      'One note a venue published about a submission: a review, meta-review, decision or comment, threaded by replyTo.',
  });

export interface SubmissionFile {
  schema: typeof SUBMISSION_SCHEMA;
  id: string;
  venue: { id: string; name: string; url: string | null };
  number: number | null;
  status: SubmissionStatus | null;
  decision: string | null;
  keywords?: string[];
  version?: string;
  url: string;
  license: string;
}

export interface FormsFile {
  schema: typeof FORMS_SCHEMA;
  forms: VenueForms;
  url: string;
  license: string;
}

export interface NoteFile {
  schema: typeof NOTE_SCHEMA;
  id: string;
  replyTo: string | null;
  kind: NoteKind;
  invitation: string;
  signature: string;
  content: Record<string, FieldValue>;
  createdAt: string;
  modifiedAt?: string | null;
  url: string;
  license: string;
}

/** Each kind of file's definition. Typed against the shapes `lib/submissions.ts` shows. */
export const REVIEW_FILE_SCHEMAS: {
  submission: z.ZodType<SubmissionFile>;
  forms: z.ZodType<FormsFile>;
  note: z.ZodType<NoteFile>;
} = { submission: submissionFileSchema, forms: formsFileSchema, note: noteFileSchema };

/** A file's schema, from its own `"schema"` field: what a reader says when it meets a newer one. */
const KNOWN_SCHEMAS: Record<ReviewFileKind, string> = {
  submission: SUBMISSION_SCHEMA,
  forms: FORMS_SCHEMA,
  note: NOTE_SCHEMA,
};

/** The first thing wrong, in words a bot's author can act on. */
export function zodProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  const where = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    return `has an unknown field “${where ? `${where}.` : ''}${issue.keys[0]}”`;
  }
  if (!where) return 'is not a JSON object';
  if (issue.code === 'invalid_type' && issue.input === undefined) return `needs “${where}”`;
  return `has a bad “${where}”: ${issue.message}`;
}

type ReviewFileOf<K extends ReviewFileKind> = K extends 'submission'
  ? SubmissionFile
  : K extends 'forms'
    ? FormsFile
    : NoteFile;

/** The file, or why it isn't one of its kind. */
export function parseReviewFile<K extends ReviewFileKind>(
  kind: K,
  text: string,
): { file: ReviewFileOf<K> } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'is not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { problem: 'is not a JSON object' };
  const named = (value as { schema?: unknown }).schema;
  if (named !== KNOWN_SCHEMAS[kind]) {
    return {
      problem:
        typeof named === 'string'
          ? `says “"schema": "${named}"”, which this site doesn't know; it reads "${KNOWN_SCHEMAS[kind]}"`
          : `needs “"schema": "${KNOWN_SCHEMAS[kind]}"”`,
    };
  }
  const parsed = REVIEW_FILE_SCHEMAS[kind].safeParse(value);
  if (!parsed.success) return { problem: zodProblem(parsed.error) };
  return { file: parsed.data as ReviewFileOf<K> };
}

/** A file as committed: a field to a line, so a change shows as the lines it changed. */
export function encodeReviewFile(file: SubmissionFile | FormsFile | NoteFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** A note as `lib/submissions.ts` shows it. */
export function noteFromFile(file: NoteFile) {
  return {
    externalId: file.id,
    replyTo: file.replyTo,
    kind: file.kind,
    invitation: file.invitation,
    signature: file.signature,
    content: file.content,
    license: file.license,
    url: file.url,
    createdAt: new Date(file.createdAt),
  };
}
