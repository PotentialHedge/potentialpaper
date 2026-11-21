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
