import type { FieldValue, NoteKind, SubmissionStatus } from '@/lib/submissions';

/**
 * Reading OpenReview's API v2 notes into submissions and their notes. Pure: the import script reads
 * notes from wherever it has them (a scrape, or the API) and hands them here. Only notes everyone may
 * read are kept, so a note shown to reviewers alone can never reach a page.
 */

export const OPENREVIEW = 'https://openreview.net';

/** The parts of an API v2 note this reads. */
export interface OpenReviewNote {
  id: string;
  forum: string;
  replyto?: string | null;
  number?: number;
  invitations?: string[];
  invitation?: string;
  signatures?: string[];
  readers?: string[];
  content?: Record<string, { value?: unknown } | undefined>;
  license?: string;
  cdate?: number;
  tcdate?: number;
  mdate?: number;
  ddate?: number | null;
}

export interface ParsedNote {
  externalId: string;
  forum: string;
  replyTo: string | null;
  kind: NoteKind;
  invitation: string;
  signature: string;
  content: Record<string, FieldValue>;
  license: string;
  url: string;
  createdAt: Date;
  modifiedAt: Date | null;
}

/** OpenReview's license for reviews and comments, which have none of their own: CC BY 4.0. */
export const OPENREVIEW_NOTE_LICENSE = 'CC-BY-4.0';

/** The kinds of note OpenReview venues use, by the end of the invitation's name. */
const KINDS: [RegExp, NoteKind][] = [
  [/^Meta_Review$/i, 'meta_review'],
  [/Review$/i, 'review'],
  [/^Decision$/i, 'decision'],
  [/^(Withdrawal|Desk_Rejection)$/i, 'withdrawal'],
  [/Comment$|^Rebuttal$|Response$/i, 'comment'],
];

/** `ICLR.cc/2027/Conference/Submission2/-/Official_Review` → `Official_Review`. */
export function invitationName(note: OpenReviewNote): string {
  const full = note.invitations?.find((id) => !id.endsWith('/-/Edit')) ?? note.invitation ?? '';
  return full.split('/-/').pop() || 'Note';
}

export function noteKind(invitation: string): NoteKind {
  return KINDS.find(([pattern]) => pattern.test(invitation))?.[1] ?? 'other';
}

/**
 * Who wrote a note, as OpenReview shows it: `…/Submission2/Reviewer_B3x7` → "Reviewer B3x7",
 * `…/Program_Chairs` → "Program Chairs", `~Ada_Lovelace1` → "Ada Lovelace".
 */
export function signatureName(signature: string | undefined): string {
  if (!signature) return 'Anonymous';
  const last = signature.split('/').pop() ?? '';
  // A profile id is the name and a number that tells namesakes apart.
  const name = last.startsWith('~') ? last.slice(1).replace(/\d+$/, '') : last;
  return name.replace(/_/g, ' ').trim() || 'Anonymous';
}

/** Text Postgres can store: no NUL, which `jsonb` refuses, and no lone surrogates. */
export function cleanText(text: string): string {
  return text.toWellFormed().replace(/\u0000/g, '');
}

/** An API v2 note's content without its `{ value }` wrappers, keeping only values a page can show. */
export function flattenContent(content: OpenReviewNote['content']): Record<string, FieldValue> {
  const flat: Record<string, FieldValue> = {};
  for (const [key, field] of Object.entries(content ?? {})) {
    const value = field?.value;
    if (typeof value === 'string') flat[key] = cleanText(value);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) flat[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) flat[key] = value.map(cleanText);
  }
  return flat;
}

export function isPublic(note: OpenReviewNote): boolean {
  return (note.readers ?? []).includes('everyone') && !note.ddate;
}

/** A reply on its forum: a note that is the submission itself is not one. `null` when it is not public. */
export function parseReply(note: OpenReviewNote): ParsedNote | null {
  if (note.id === note.forum || !isPublic(note)) return null;
  const invitation = invitationName(note);
  const created = note.cdate ?? note.tcdate;
  return {
    externalId: note.id,
    forum: note.forum,
    replyTo: note.replyto && note.replyto !== note.forum ? note.replyto : null,
    kind: noteKind(invitation),
    invitation,
    signature: cleanText(signatureName(note.signatures?.[0])),
    content: flattenContent(note.content),
    license: note.license ? licenseId(note.license) : OPENREVIEW_NOTE_LICENSE,
    url: `${OPENREVIEW}/forum?id=${encodeURIComponent(note.forum)}&noteId=${encodeURIComponent(note.id)}`,
    createdAt: new Date(created ?? 0),
    modifiedAt: note.mdate ? new Date(note.mdate) : null,
  };
}

/** OpenReview writes `CC BY 4.0`; DESIGN.md §3 keeps SPDX ids where the version is named. */
export function licenseId(label: string): string {
  const match = /^CC[ -]?(BY(?:[ -](?:SA|NC|ND|NC[ -]SA|NC[ -]ND))?)[ -](\d\.\d)$/i.exec(label.trim());
  if (match) return `CC-${match[1].toUpperCase().replace(/ /g, '-')}-${match[2]}`;
  if (/^CC0/i.test(label.trim())) return 'CC0-1.0';
  return label.trim();
}

/**
 * Where a submission stands, from the venue id OpenReview files it under
 * (`ICLR.cc/2027/Conference/Withdrawn_Submission`) and its decision, if any.
 */
export function submissionStatus(venueId: string | null, decision: string | null): SubmissionStatus | null {
  const group = venueId?.split('/').pop() ?? '';
  if (/Desk_Rejected/i.test(group)) return 'desk_rejected';
  if (/Withdrawn/i.test(group)) return 'withdrawn';
  if (decision) return /^accept/i.test(decision.trim()) ? 'accepted' : /reject/i.test(decision) ? 'rejected' : null;
  if (/Rejected/i.test(group)) return 'rejected';
  if (/Submission$/i.test(group)) return 'under_review';
  // An accepted paper is filed under the venue itself: `ICLR.cc/2026/Conference`.
  if (venueId && group && !/Submission/i.test(group)) return 'accepted';
  return null;
}

export function forumUrl(forum: string): string {
  return `${OPENREVIEW}/forum?id=${encodeURIComponent(forum)}`;
}

export function venueUrl(venueGroup: string): string {
  return `${OPENREVIEW}/group?id=${encodeURIComponent(venueGroup)}`;
}
