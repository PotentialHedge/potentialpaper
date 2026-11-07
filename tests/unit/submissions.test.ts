import { describe, expect, it } from 'vitest';
import {
  formatScore,
  scoreOf,
  scoreTable,
  shownFields,
  threads,
  type NoteForm,
  type Submission,
  type SubmissionNote,
  type VenueForms,
} from '@/lib/submissions';
import {
  licenseId,
  noteKind,
  parseReply,
  signatureName,
  submissionStatus,
  type OpenReviewNote,
} from '@/server/venue-sources/openreview';

const REVIEW_FORM: NoteForm = {
  label: 'Official review',
  summary: ['rating', 'confidence'],
  fields: [
    { key: 'rating', label: 'Rating', type: 'score', max: 10 },
    { key: 'confidence', label: 'Confidence', type: 'score' },
    { key: 'summary', label: 'Summary', type: 'text' },
    { key: 'flag', label: 'Flag', type: 'choice', omitWhen: ['No'] },
    { key: 'code_of_conduct', label: 'Code of conduct', hidden: true },
  ],
};

let at = 0;
function note(fields: Partial<SubmissionNote> & Pick<SubmissionNote, 'externalId'>): SubmissionNote {
  at += 1;
  return {
    replyTo: null,
    kind: 'review',
    invitation: 'Official_Review',
    signature: `Reviewer ${fields.externalId}`,
    content: {},
    license: 'CC-BY-4.0',
    url: null,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, at)),
    ...fields,
  };
}

function submission(notes: SubmissionNote[], forms: VenueForms = { Official_Review: REVIEW_FORM }): Submission {
  return {
    venue: { id: 'openreview:X', name: 'X 2027', url: null, forms },
    externalId: 'f1',
    number: 1,
    status: 'under_review',
    decision: null,
    url: null,
    fetchedAt: new Date(),
    notes,
  };
}

describe("a note's fields", () => {
  it("follow the form's order and labels, then show the rest by what they look like", () => {
    const fields = shownFields(
      {
        content: {
          extra_score: 3,
          summary: 'Long.\nText.',
          rating: '6: marginally above',
          code_of_conduct: 'Yes',
          flag: 'No',
          tag_line: 'short',
          empty: '  ',
        },
      },
      REVIEW_FORM,
    );
    expect(fields.map((field) => [field.key, field.label, field.type])).toEqual([
      ['rating', 'Rating', 'score'],
      ['summary', 'Summary', 'text'],
      ['extra_score', 'Extra score', 'score'],
      ['tag_line', 'Tag line', 'choice'],
    ]);
    expect(fields[0]).toMatchObject({ value: 6, max: 10 });
  });

  it('show everything without a form', () => {
    const fields = shownFields({ content: { a: 1, b: ['x', 'y'], c: true } }, undefined);
    expect(fields.map((field) => field.text)).toEqual(['1', 'x, y', 'Yes']);
  });

  it('read scores written as numbers or as "n: label"', () => {
    expect(scoreOf(3)).toBe(3);
    expect(scoreOf('8: accept, good paper')).toBe(8);
    expect(scoreOf('-1')).toBe(-1);
    expect(scoreOf('good')).toBeNull();
    expect(scoreOf(['3'])).toBeNull();
  });
});

describe('the score table', () => {
  it("has the form's summary columns, in its order, and their means", () => {
    const table = scoreTable(
      submission([
        note({ externalId: 'a', content: { confidence: 2, rating: 4, other: 9 } }),
        note({ externalId: 'b', content: { rating: 1 } }),
        note({ externalId: 'c', kind: 'meta_review', invitation: 'Meta_Review', content: { rating: 10 } }),
      ]),
    )!;
    expect(table.columns.map((column) => column.key)).toEqual(['rating', 'confidence']);
    expect(table.rows.map((row) => row.scores)).toEqual([
      [4, 2],
      [1, null],
    ]);
    expect(table.means).toEqual([2.5, 2]);
  });

  it('uses every score without a summary, and is absent without one', () => {
    const plain = submission([note({ externalId: 'a', content: { novelty: 3, text: 'x' } })], {});
    expect(scoreTable(plain)!.columns.map((column) => column.label)).toEqual(['Novelty']);
    expect(scoreTable(submission([note({ externalId: 'a', content: { text: 'x' } })]))).toBeNull();
  });

  it('prints means as reviews print scores', () => {
    expect(formatScore(3)).toBe('3');
    expect(formatScore(2.5)).toBe('2.5');
    expect(formatScore(8 / 3)).toBe('2.67');
  });
});

describe('threads', () => {
  it('put the decision first and replies under what they answer, oldest first', () => {
    const review = note({ externalId: 'r1' });
    const reply = note({ externalId: 'c1', kind: 'comment', replyTo: 'r1' });
    const replyToReply = note({ externalId: 'c2', kind: 'comment', replyTo: 'c1' });
    const decision = note({ externalId: 'd', kind: 'decision' });
    const orphan = note({ externalId: 'c3', kind: 'comment', replyTo: 'gone' });
    const forum = threads([replyToReply, orphan, review, decision, reply]);
    expect(forum.map((thread) => thread.note.externalId)).toEqual(['d', 'r1', 'c3']);
    expect(forum[1].replies[0].note.externalId).toBe('c1');
    expect(forum[1].replies[0].replies[0].note.externalId).toBe('c2');
  });

  it('drops nothing when notes answer each other in a loop', () => {
    const forum = threads([
      note({ externalId: 'a', kind: 'comment', replyTo: 'b' }),
      note({ externalId: 'b', kind: 'comment', replyTo: 'a' }),
    ]);
    const all = (list: typeof forum): string[] => list.flatMap((t) => [t.note.externalId, ...all(t.replies)]);
    expect(all(forum).sort()).toEqual(['a', 'b']);
  });
});

describe('OpenReview notes', () => {
  const REVIEW: OpenReviewNote = {
    id: 'n1',
    forum: 'f1',
    replyto: 'f1',
    invitations: ['ICLR.cc/2027/Conference/Submission2/-/Official_Review', 'ICLR.cc/2027/Conference/-/Edit'],
    signatures: ['ICLR.cc/2027/Conference/Submission2/Reviewer_B3x7'],
    readers: ['everyone'],
    content: { rating: { value: 4 }, summary: { value: 'Fine\u0000.' }, nested: { value: { a: 1 } } },
    license: 'CC BY 4.0',
    cdate: 1793848807349,
  };

  it('become notes with their kind, writer, license and link', () => {
    expect(parseReply(REVIEW)).toMatchObject({
      externalId: 'n1',
      replyTo: null,
      kind: 'review',
      invitation: 'Official_Review',
      signature: 'Reviewer B3x7',
      content: { rating: 4, summary: 'Fine.' },
      license: 'CC-BY-4.0',
      url: 'https://openreview.net/forum?id=f1&noteId=n1',
    });
  });

  it('are kept only when everyone may read them', () => {
    expect(parseReply({ ...REVIEW, readers: ['ICLR.cc/2027/Conference/Program_Chairs'] })).toBeNull();
    expect(parseReply({ ...REVIEW, ddate: 1 })).toBeNull();
    expect(parseReply({ ...REVIEW, id: 'f1' })).toBeNull();
  });

  it('keep the note they answer', () => {
    expect(parseReply({ ...REVIEW, replyto: 'n0' })?.replyTo).toBe('n0');
  });

  it('are sorted into kinds', () => {
    expect(
      [
        'Official_Review',
        'Ethics_Review',
        'Meta_Review',
        'Decision',
        'Official_Comment',
        'Rebuttal',
        'Withdrawal',
        'Revision',
      ].map(noteKind),
    ).toEqual(['review', 'review', 'meta_review', 'decision', 'comment', 'comment', 'withdrawal', 'other']);
  });

  it('name their writer as OpenReview does', () => {
    expect(signatureName('ICLR.cc/2026/Conference/Submission3/Area_Chair_qfG5')).toBe('Area Chair qfG5');
    expect(signatureName('ICLR.cc/2026/Conference/Program_Chairs')).toBe('Program Chairs');
    expect(signatureName('~Ada_Lovelace1')).toBe('Ada Lovelace');
    expect(signatureName(undefined)).toBe('Anonymous');
  });

  it('record licenses as SPDX ids', () => {
    expect(licenseId('CC BY 4.0')).toBe('CC-BY-4.0');
    expect(licenseId('CC BY-SA 4.0')).toBe('CC-BY-SA-4.0');
    expect(licenseId('CC0 1.0')).toBe('CC0-1.0');
    expect(licenseId('Custom')).toBe('Custom');
  });
});

describe('where a submission stands', () => {
  it('follows the venue id it is filed under, then its decision', () => {
    expect(submissionStatus('ICLR.cc/2027/Conference/Submission', null)).toBe('under_review');
    expect(submissionStatus('ICLR.cc/2026/Conference/Withdrawn_Submission', null)).toBe('withdrawn');
    expect(submissionStatus('ICLR.cc/2026/Conference/Desk_Rejected_Submission', null)).toBe('desk_rejected');
    expect(submissionStatus('ICLR.cc/2026/Conference/Rejected_Submission', null)).toBe('rejected');
    expect(submissionStatus('ICLR.cc/2026/Conference', null)).toBe('accepted');
    expect(submissionStatus('ICLR.cc/2026/Conference/Submission', 'Accept (Poster)')).toBe('accepted');
    expect(submissionStatus('ICLR.cc/2026/Conference/Submission', 'Reject')).toBe('rejected');
    expect(submissionStatus(null, null)).toBeNull();
  });
});
