import { describe, expect, it } from 'vitest';
import {
  encodeReviewFile,
  noteFilePath,
  parseReviewFile,
  parseReviewPath,
  submissionFilePath,
  type NoteFile,
  type SubmissionFile,
} from '@/lib/review-files';
import { contentProblem, grantCovers, grantProblem, layoutProblem, pathDenied } from '@/server/pages/rules';
import { fileTypeOf, indexFile, pageJsonSchema } from '@/server/pages/schemas';

const SUBMISSION: SubmissionFile = {
  schema: 'submission/1',
  id: 'dskf2Ppd9o',
  venue: {
    id: 'ICLR.cc/2027/Conference',
    name: 'ICLR 2027',
    url: 'https://openreview.net/group?id=ICLR.cc/2027/Conference',
  },
  number: 1234,
  url: 'https://openreview.net/forum?id=dskf2Ppd9o',
  license: 'CC-BY-4.0',
};

const NOTE: NoteFile = {
  schema: 'review/1',
  id: 'AbC123xyz',
  replyTo: null,
  kind: 'review',
  invitation: 'Official_Review',
  signature: 'Reviewer B3x7',
  content: {
    rating: '8: accept, good paper',
    confidence: 4,
    summary: 'Masked diffusion, recursively.',
    flag: false,
    tags: ['a', 'b'],
  },
  createdAt: '2026-11-01T12:00:00.000Z',
  url: 'https://openreview.net/forum?id=dskf2Ppd9o&noteId=AbC123xyz',
  license: 'CC-BY-4.0',
};

const roles = { system: false, admin: false, verified: true, owner: false, claimed: false };

describe('review paths', () => {
  it('knows the three files of a submission folder', () => {
    expect(submissionFilePath('openreview', 'dskf2Ppd9o')).toBe('reviews/openreview/dskf2ppd9o/submission.json');
    expect(noteFilePath('openreview', 'dskf2Ppd9o', 'AbC123xyz')).toBe(
      'reviews/openreview/dskf2ppd9o/notes/abc123xyz.json',
    );
    expect(parseReviewPath('reviews/openreview/dskf2ppd9o/forms.json')).toEqual({
      source: 'openreview',
      submission: 'dskf2ppd9o',
      kind: 'forms',
    });
    expect(parseReviewPath('reviews/openreview/dskf2ppd9o/notes/abc.json')).toMatchObject({
      kind: 'note',
      note: 'abc',
    });
    for (const bad of [
      'reviews/openreview/dskf2ppd9o/other.json',
      'reviews/OpenReview/x/submission.json',
      'reviews/openreview/Upper/submission.json',
      'reviews/openreview/x/notes/a/b.json',
      'reviews/openreview/x/notes/a.md',
      'reviews/openreview/submission.json',
    ]) {
      expect(parseReviewPath(bad), bad).toBeNull();
      expect(layoutProblem(bad), bad).toMatch(/reviews\/<source>/);
    }
    expect(layoutProblem('reviews/openreview/x/notes/a_b-c.json')).toBeNull();
  });

  it('lets only the granted bot and admins write a source folder', () => {
    const path = 'reviews/openreview/x/submission.json';
    const bot = { ...roles, grants: ['reviews/openreview/**'] };
    expect(pathDenied(path, bot)).toBeNull();
    expect(pathDenied('reviews/jmlr/x/submission.json', bot)).toMatch(/reviews\/jmlr\//);
    expect(pathDenied(path, roles)).toMatch(/only the bot granted reviews\/openreview\//);
    expect(pathDenied(path, { ...roles, owner: true, claimed: true })).not.toBeNull();
    expect(pathDenied(path, { ...roles, system: true, verified: false })).not.toBeNull();
    expect(pathDenied(path, { ...roles, admin: true })).toBeNull();
    // A grant is no wider than its folder.
    expect(pathDenied('community/10-summary.md', bot)).toBeNull();
    expect(pathDenied('.potentialpaper/metadata.json', bot)).not.toBeNull();
  });

  it('grants only a source folder, and covers only what is under it', () => {
    expect(grantProblem('reviews/openreview/**')).toBeNull();
    for (const bad of ['reviews/**', 'reviews/OpenReview/**', 'community/**', 'reviews/a/b/**', '**']) {
      expect(grantProblem(bad), bad).not.toBeNull();
    }
    expect(grantCovers('reviews/openreview/**', 'reviews/openreview/x/submission.json')).toBe(true);
    expect(grantCovers('reviews/openreview/**', 'reviews/openreview-x/y/submission.json')).toBe(false);
  });
});

describe('review files', () => {
  it('reads a valid file of each kind', () => {
    expect(parseReviewFile('submission', encodeReviewFile(SUBMISSION))).toEqual({ file: SUBMISSION });
    expect(parseReviewFile('note', encodeReviewFile(NOTE))).toEqual({ file: NOTE });
    const forms = {
      schema: 'forms/1',
      forms: {
        Official_Review: {
          label: 'Official review',
          fields: [{ key: 'rating', label: 'Rating', type: 'score', max: 10 }],
          summary: ['rating'],
        },
      },
      url: 'https://openreview.net/group?id=ICLR.cc/2027/Conference',
      license: 'CC-BY-4.0',
    };
    expect(contentProblem('reviews/openreview/x/forms.json', JSON.stringify(forms))).toBeNull();
  });

  it('says what is wrong with one that is not', () => {
    const note = (patch: Record<string, unknown>) =>
      contentProblem('reviews/openreview/x/notes/a.json', JSON.stringify({ ...NOTE, ...patch }));
    expect(note({ schema: 'review/2' })).toMatch(/review\/2.*doesn't know/);
    expect(note({ schema: undefined })).toMatch(/needs .*review\/1/);
    expect(note({ kind: 'rant' })).toMatch(/“kind”/);
    expect(note({ url: 'http://openreview.net/x' })).toMatch(/“url”: needs an https address/);
    expect(note({ license: undefined })).toBe('needs “license”');
    expect(note({ extra: 1 })).toBe('has an unknown field “extra”');
    expect(note({ content: { nested: { a: 1 } } })).toMatch(/content\.nested/);
    expect(note({ createdAt: 'yesterday' })).toMatch(/createdAt/);
    expect(contentProblem('reviews/openreview/x/submission.json', '[]')).toBe('is not a JSON object');
    expect(
      contentProblem('reviews/openreview/x/submission.json', JSON.stringify({ ...SUBMISSION, status: 'maybe' })),
    ).toMatch(/status/);
  });
});

describe('the file type registry', () => {
  it('finds a type by path, and indexes a review with its scores', () => {
    expect(fileTypeOf('reviews/openreview/x/notes/a.json')).toBe('note');
    expect(fileTypeOf('reviews/openreview/x/submission.json')).toBe('submission');
    expect(fileTypeOf('links/10-code.json')).toBe('link');
    expect(fileTypeOf('community/10-summary.md')).toBe('section');
    expect(fileTypeOf('community/notes.txt')).toBeNull();
    const [doc] = indexFile('reviews/openreview/x/notes/a.json', JSON.stringify(NOTE))!;
    expect(doc.kind).toBe('note');
    expect(doc.text).toContain('Masked diffusion, recursively.');
    expect(doc.fields).toMatchObject({ noteKind: 'review', signature: 'Reviewer B3x7', rating: 8, confidence: 4 });
    expect(
      indexFile(
        'reviews/openreview/x/forms.json',
        '{"schema":"forms/1","forms":{},"url":"https://a.org","license":"x"}',
      ),
    ).toEqual([]);
    expect(indexFile('reviews/openreview/x/notes/a.json', '{}')).toBeNull();
  });

  it('serves each review schema with its version fixed', () => {
    const note = pageJsonSchema('note') as { properties: { schema: { const?: string } }; required: string[] };
    expect(note.properties.schema.const).toBe('review/1');
    expect(note.required).toEqual(expect.arrayContaining(['schema', 'id', 'kind', 'content', 'license', 'url']));
  });
});
