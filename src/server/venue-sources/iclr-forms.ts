import type { FieldSpec, NoteForm, VenueForms } from '@/lib/submissions';

/**
 * How to show ICLR's notes on OpenReview, by year. Labels and order follow each year's review form.
 * Ranges are left out where ICLR hasn't published them: guests can't read 2027's form.
 */

const META_REVIEW: NoteForm = {
  label: 'Meta-review',
  fields: [
    { key: 'metareview', label: 'Meta-review', type: 'text' },
    { key: 'summary', label: 'Summary', type: 'text' },
    { key: 'additional_comments_on_reviewer_discussion', label: 'Reviewer discussion', type: 'text' },
    { key: 'recommendation', label: 'Recommendation', type: 'choice' },
  ],
};

const DECISION: NoteForm = {
  label: 'Decision',
  fields: [
    { key: 'title', label: 'Title', hidden: true },
    { key: 'decision', label: 'Decision', type: 'choice' },
    { key: 'comment', label: 'Comment', type: 'text' },
  ],
};

const COMMENT: NoteForm = {
  label: 'Comment',
  fields: [
    { key: 'title', label: 'Title', type: 'choice' },
    { key: 'comment', label: 'Comment', type: 'text' },
  ],
};

const COMMON: VenueForms = {
  Meta_Review: META_REVIEW,
  Decision: DECISION,
  Official_Comment: COMMENT,
  Public_Comment: { ...COMMENT, label: 'Public comment' },
  Withdrawal: {
    label: 'Withdrawal',
    fields: [{ key: 'withdrawal_confirmation', label: 'Confirmation', hidden: true }],
  },
  Desk_Rejection: { label: 'Desk rejection', fields: [{ key: 'desk_reject_comments', label: 'Reason', type: 'text' }] },
};

const ETHICS: FieldSpec[] = [
  {
    key: 'flag_for_ethics_review',
    label: 'Flag for ethics review',
    type: 'choice',
    omitWhen: ['No', 'No ethics review needed.'],
  },
  { key: 'details_of_ethics_concerns', label: 'Ethics concerns', type: 'text' },
];

export const ICLR_FORMS: Record<number, VenueForms> = {
  2027: {
    ...COMMON,
    Official_Review: {
      label: 'Official review',
      summary: ['rating', 'confidence', 'soundness', 'presentation', 'informativeness'],
      fields: [
        { key: 'rating', label: 'Rating', type: 'score' },
        { key: 'confidence', label: 'Confidence', type: 'score' },
        { key: 'soundness', label: 'Soundness', type: 'score' },
        { key: 'presentation', label: 'Presentation', type: 'score' },
        { key: 'informativeness', label: 'Informativeness', type: 'score' },
        { key: 'paper_summary', label: 'Summary', type: 'text' },
        { key: 'critical_strengths', label: 'Strengths', type: 'text' },
        { key: 'critical_weaknesses', label: 'Weaknesses', type: 'text' },
        { key: 'questions_for_authors', label: 'Questions for the authors', type: 'text' },
        ...ETHICS,
      ],
    },
  },
  2026: {
    ...COMMON,
    Official_Review: {
      label: 'Official review',
      summary: ['rating', 'confidence', 'soundness', 'presentation', 'contribution'],
      fields: [
        { key: 'rating', label: 'Rating', type: 'score', min: 0, max: 10 },
        { key: 'confidence', label: 'Confidence', type: 'score', min: 1, max: 5 },
        { key: 'soundness', label: 'Soundness', type: 'score', min: 1, max: 4 },
        { key: 'presentation', label: 'Presentation', type: 'score', min: 1, max: 4 },
        { key: 'contribution', label: 'Contribution', type: 'score', min: 1, max: 4 },
        { key: 'summary', label: 'Summary', type: 'text' },
        { key: 'strengths', label: 'Strengths', type: 'text' },
        { key: 'weaknesses', label: 'Weaknesses', type: 'text' },
        { key: 'questions', label: 'Questions', type: 'text' },
        ...ETHICS,
        { key: 'code_of_conduct', label: 'Code of conduct', hidden: true },
      ],
    },
  },
};

/** The forms of a venue by its OpenReview group, where we know them. Without, fields are shown as they come. */
export function openReviewForms(group: string): VenueForms {
  const year = /^ICLR\.cc\/(\d{4})\/Conference$/.exec(group)?.[1];
  return (year && ICLR_FORMS[Number(year)]) || {};
}
