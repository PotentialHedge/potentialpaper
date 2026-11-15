import { describe, expect, it } from 'vitest';
import { mergeWithMarkers } from '@/server/pages/merge';
import { readCommitMessage } from '@/server/workspace';

const labels = { ours: 'yours', theirs: 'theirs' };

describe('merging with conflict markers', () => {
  it('merges what does not touch, and marks only the lines both changed', () => {
    const base = 'a\nb\nc\nd\ne\n';
    const ours = 'a\nB\nc\nd\nE\n';
    const theirs = 'A\nb2\nc\nd\ne\n';
    expect(mergeWithMarkers(base, ours, theirs, labels)).toEqual({
      content: '<<<<<<< yours\na\nB\n=======\nA\nb2\n>>>>>>> theirs\nc\nd\nE\n',
      conflict: true,
    });
    expect(mergeWithMarkers(base, ours, base, labels)).toEqual({ content: ours, conflict: false });
    expect(mergeWithMarkers(base, 'a\nb\nc\nd\nE\n', theirs, labels)).toEqual({
      content: 'A\nb2\nc\nd\nE\n',
      conflict: false,
    });
  });

  it('keeps the side that still has a file the other deleted', () => {
    expect(mergeWithMarkers('a\n', null, 'b\n', labels)).toEqual({ content: 'b\n', conflict: true });
    expect(mergeWithMarkers('a\n', 'b\n', null, labels)).toEqual({ content: 'b\n', conflict: true });
  });

  it('marks two different new files as a whole', () => {
    expect(mergeWithMarkers(null, 'x\n', 'y\n', labels)).toEqual({
      content: '<<<<<<< yours\nx\n=======\ny\n>>>>>>> theirs\n',
      conflict: true,
    });
  });
});

describe("a web editor's commit message", () => {
  it('is a summary and Evidence trailers, as a pushed commit is', () => {
    expect(readCommitMessage('Fix it\n\nWhy.\n\nEvidence: https://a.org/1\nEvidence: https://b.org/2')).toEqual({
      summary: 'Fix it',
      evidence: ['https://a.org/1', 'https://b.org/2'],
    });
    expect(readCommitMessage('Just this')).toEqual({ summary: 'Just this', evidence: [] });
    expect(() => readCommitMessage('X\n\nCo-authored-by: A <a@b.c>')).toThrow(/Evidence/);
  });
});
