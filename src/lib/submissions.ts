/**
 * A paper's submissions to venues, and what the venue published about each: reviews, meta-reviews,
 * decisions and comments (DESIGN.md §3). Nothing here knows a particular venue. A venue says how to
 * show its notes through a `NoteForm` per kind of note, and a field no form names is still shown, by
 * what its value looks like. Pure, so the page and the tests share it.
 */

export const SUBMISSION_STATUSES = ['under_review', 'accepted', 'rejected', 'withdrawn', 'desk_rejected'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const STATUS_LABELS: Record<SubmissionStatus, string> = {
  under_review: 'Under review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  desk_rejected: 'Desk rejected',
};

/** What a note is, whatever the venue calls it. Decides where the page puts it. */
export const NOTE_KINDS = ['review', 'meta_review', 'decision', 'comment', 'withdrawal', 'other'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

/** A field's value as the venue gave it. A choice from a list may come as `"3: good"`. */
export type FieldValue = string | number | boolean | string[];

/** How to show one field of a note. */
export interface FieldSpec {
  key: string;
  label: string;
  /**
   * `score` is a number, averaged across reviews; `choice` a short answer shown on one line; `text` a
   * passage. Left out, it is told from the value.
   */
  type?: 'score' | 'choice' | 'text';
  /** A score's range, only where the venue states it. */
  min?: number;
  max?: number;
  /** Not shown: boilerplate such as a code-of-conduct box. */
  hidden?: boolean;
  /** Not shown when it says one of these, the answer nearly every note gives: `["No"]`. */
  omitWhen?: string[];
}

/** How to show one kind of note, such as a venue's `Official_Review`. Fields are shown in this order. */
export interface NoteForm {
  /** "Official review". */
  label: string;
  fields: FieldSpec[];
  /** The scores in the submission's summary table, in order. Left out: every score of its notes. */
  summary?: string[];
}

/** A venue's forms, by the source's name for the kind of note (`Official_Review`, `Meta_Review`, …). */
export type VenueForms = Record<string, NoteForm>;

export interface SubmissionNote {
  /** The source's id for it. */
  externalId: string;
  /** The note it answers, by `externalId`; `null` when it answers the submission. */
  replyTo: string | null;
  kind: NoteKind;
  /** The source's name for its kind, the key of its form. */
  invitation: string;
  /** Who wrote it, as the venue shows them: "Reviewer B3x7", "Authors", "Area Chair qfG5". */
  signature: string;
  content: Record<string, FieldValue>;
  license: string;
  /** Where it is at the source, linked from its credit. */
  url: string | null;
  createdAt: Date;
  /** Its scores that differ from the first ones recorded, as a reviewer raises or lowers one after the rebuttal. */
  scoreChanges: ScoreChange[];
}

/**
 * A review's score that has moved since it was first recorded: `field` is its key in the note's `content`, `from` the
 * score as first recorded, `at` when its current value was first seen (no later than the import after the reviewer
 * changed it). As acceptodds keeps a review's `scoreChanges`.
 */
export interface ScoreChange {
  field: string;
  from: number;
  at: string;
}

export interface Submission {
  venue: { id: string; name: string; url: string | null; forms: VenueForms };
  /** The source's id for the submission, an OpenReview forum id. */
  externalId: string;
  number: number | null;
  status: SubmissionStatus | null;
  /** The decision as the venue words it: "Accept (Poster)". */
  decision: string | null;
  /** The keywords its authors gave the venue (OpenReview's), from its `submission.json`. */
  keywords: string[];
  /** The area its authors chose from the venue's list: "reinforcement learning". Not one of the site's categories. */
  primaryArea: string | null;
  /** Its one-sentence summary, as its authors gave it. */
  tldr: string | null;
  url: string | null;
  fetchedAt: Date;
  notes: SubmissionNote[];
}

/** One field ready to show. */
export type ShownField =
  | { key: string; label: string; type: 'score'; value: number; text: string; max?: number }
  | { key: string; label: string; type: 'choice' | 'text'; text: string };

/** `"official_review"` → `"Official review"`. */
export function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

const LEADING_NUMBER = /^\s*(-?\d+(?:\.\d+)?)\s*(?::|$)/;

/** A field's number: `3`, or `"3: good"` as older OpenReview forms give it. */
export function scoreOf(value: FieldValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const match = LEADING_NUMBER.exec(value);
    return match ? Number(match[1]) : null;
  }
  return null;
}

function textOf(value: FieldValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value).trim();
}

/** Short and on one line: shown beside its label rather than under it. */
const CHOICE_LENGTH = 80;

function show(spec: FieldSpec, value: FieldValue): ShownField | null {
  const text = textOf(value);
  if (text === '' || spec.omitWhen?.includes(text)) return null;
  const type =
    spec.type ??
    (typeof value === 'number' ? 'score' : text.length <= CHOICE_LENGTH && !text.includes('\n') ? 'choice' : 'text');
  if (type === 'score') {
    const score = scoreOf(value);
    if (score !== null) return { key: spec.key, label: spec.label, type, value: score, text, max: spec.max };
    return { key: spec.key, label: spec.label, type: 'choice', text };
  }
  return { key: spec.key, label: spec.label, type, text };
}

/**
 * A note's fields to show, in its form's order and then in the order the source gave the rest. Empty
 * and hidden fields are left out. Without a form, every field is shown by what its value looks like.
 */
export function shownFields(note: Pick<SubmissionNote, 'content'>, form: NoteForm | undefined): ShownField[] {
  const specs = new Map((form?.fields ?? []).map((spec) => [spec.key, spec]));
  const keys = [...specs.keys(), ...Object.keys(note.content).filter((key) => !specs.has(key))];
  return keys.flatMap((key) => {
    const spec = specs.get(key) ?? { key, label: humanize(key) };
    const value = note.content[key];
    if (spec.hidden || value === undefined || value === null) return [];
    return show(spec, value) ?? [];
  });
}

export function formOf(submission: Pick<Submission, 'venue'>, note: Pick<SubmissionNote, 'invitation'>) {
  return submission.venue.forms[note.invitation];
}

export function noteLabel(submission: Pick<Submission, 'venue'>, note: Pick<SubmissionNote, 'invitation'>): string {
  return formOf(submission, note)?.label ?? humanize(note.invitation);
}

export interface ScoreTable {
  columns: { key: string; label: string; max?: number }[];
  rows: { note: SubmissionNote; scores: (number | null)[] }[];
  /** Each column's mean over the reviews that gave it, or `null`. */
  means: (number | null)[];
}

/**
 * The reviews' scores side by side, for the submission's summary. Columns are the review form's
 * `summary`, or else every score any review gave, in form order. `null` without a review with a score.
 */
export function scoreTable(submission: Submission): ScoreTable | null {
  const reviews = submission.notes.filter((note) => note.kind === 'review');
  const columns: ScoreTable['columns'] = [];
  const seen = new Set<string>();
  for (const review of reviews) {
    const form = formOf(submission, review);
    const wanted = form?.summary;
    for (const field of shownFields(review, form)) {
      if (field.type !== 'score' || seen.has(field.key)) continue;
      if (wanted && !wanted.includes(field.key)) continue;
      seen.add(field.key);
      columns.push({ key: field.key, label: field.label, max: field.max });
    }
    // A form's `summary` sets the columns' order, too.
    if (wanted) columns.sort((a, b) => wanted.indexOf(a.key) - wanted.indexOf(b.key));
  }
  if (columns.length === 0) return null;
  const rows = reviews.map((note) => ({ note, scores: columns.map(({ key }) => scoreOf(note.content[key])) }));
  const means = columns.map((_, index) => {
    const given = rows.map((row) => row.scores[index]).filter((score): score is number => score !== null);
    return given.length ? given.reduce((sum, score) => sum + score, 0) / given.length : null;
  });
  return { columns, rows, means };
}

const KIND_ORDER: Record<NoteKind, number> = {
  decision: 0,
  withdrawal: 1,
  meta_review: 2,
  review: 3,
  comment: 4,
  other: 5,
};

export interface NoteThread {
  note: SubmissionNote;
  replies: NoteThread[];
}

/**
 * The notes as a forum shows them: those that answer the submission, decision first, then the
 * meta-review, the reviews and other comments, each followed by its replies, oldest first. A note whose
 * parent is missing answers the submission, so nothing is dropped.
 */
export function threads(notes: SubmissionNote[]): NoteThread[] {
  const ids = new Set(notes.map((note) => note.externalId));
  const children = new Map<string | null, SubmissionNote[]>();
  for (const note of notes) {
    const parent = note.replyTo && ids.has(note.replyTo) && note.replyTo !== note.externalId ? note.replyTo : null;
    children.set(parent, [...(children.get(parent) ?? []), note]);
  }
  const byTime = (a: SubmissionNote, b: SubmissionNote) => a.createdAt.getTime() - b.createdAt.getTime();
  const visited = new Set<string>();
  const thread = (note: SubmissionNote): NoteThread => {
    visited.add(note.externalId);
    const replies = (children.get(note.externalId) ?? []).filter((reply) => !visited.has(reply.externalId));
    return { note, replies: replies.sort(byTime).map(thread) };
  };
  const roots = (children.get(null) ?? []).map(thread);
  // Notes that only answer each other, in a loop, are reached from nowhere: they answer the submission.
  for (const note of [...notes].sort(byTime)) if (!visited.has(note.externalId)) roots.push(thread(note));
  return roots.sort((a, b) => KIND_ORDER[a.note.kind] - KIND_ORDER[b.note.kind] || byTime(a.note, b.note));
}

/** A mean as a review's scores are given: `2.67`, or `3` when whole. */
export function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(2).replace(/0$/, '');
}

/** The keys of a note's fields shown as scores (`shownFields`), the ones whose moves are kept. */
function scoreKeys(content: SubmissionNote['content'], form: NoteForm | undefined): Set<string> {
  return new Set(
    shownFields({ content }, form)
      .filter((field) => field.type === 'score')
      .map((field) => field.key),
  );
}

/**
 * A note's score changes once its content becomes `content`, from what its file said before (`previous`, with the
 * changes it kept): a score now unlike the first one recorded keeps that first one as `from`, and `at` is `now` when it
 * moved just now, else when it last did. A score back where it started has none. Without a previous file, none.
 */
export function nextScoreChanges(
  previous: { content: SubmissionNote['content']; scoreChanges?: ScoreChange[] } | null,
  content: SubmissionNote['content'],
  form: NoteForm | undefined,
  now: string,
): ScoreChange[] {
  if (!previous) return [];
  const kept = new Map((previous.scoreChanges ?? []).map((change) => [change.field, change]));
  const before = scoreKeys(previous.content, form);
  const out: ScoreChange[] = [];
  for (const field of scoreKeys(content, form)) {
    const to = scoreOf(content[field]);
    const last = before.has(field) ? scoreOf(previous.content[field]) : null;
    const from = kept.get(field)?.from ?? last;
    if (to === null || from === null || to === from) continue;
    out.push({ field, from, at: last === to ? (kept.get(field)?.at ?? now) : now });
  }
  return out.sort((a, b) => a.field.localeCompare(b.field));
}

/**
 * How a review's score moved since it was first recorded: the mark beside it, `(+1)`, and a sentence for its title.
 * `null` when it is back where it started. As acceptodds marks one.
 */
export function scoreMove(
  label: string,
  to: number,
  change: Pick<ScoreChange, 'from' | 'at'>,
): { delta: number; mark: string; title: string } | null {
  const delta = Math.round((to - change.from) * 100) / 100;
  if (delta === 0) return null;
  const day = new Date(change.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return {
    delta,
    mark: `(${delta > 0 ? '+' : '−'}${Math.abs(delta)})`,
    title:
      `The reviewer ${delta > 0 ? 'raised' : 'lowered'} ${label.toLowerCase()} from ${formatScore(change.from)} to ` +
      `${formatScore(to)} after posting the review (first seen ${day}).`,
  };
}
