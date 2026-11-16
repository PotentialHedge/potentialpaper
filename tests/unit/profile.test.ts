import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { cleanHandleInput, handleProblem, HANDLE_PATTERN, shownHandle } from '@/lib/profile';

describe('handleProblem', () => {
  it('accepts ordinary handles, including pseudonyms', () => {
    for (const h of ['ada', 'ada-lovelace', 'x9z', 'reviewer-2']) expect(handleProblem(h)).toBeNull();
  });

  it('refuses malformed handles', () => {
    for (const h of ['', 'ab', 'Ada', '-ada', 'ada-', 'a b c', 'a'.repeat(31), 'ad_a']) {
      expect(handleProblem(h)).not.toBeNull();
    }
  });

  it('refuses names that would read as the site, and the placeholder shape', () => {
    for (const h of ['admin', 'moderator', 'potentialpaper', 'anonymous', 'user-a1b2c3']) {
      expect(handleProblem(h)).toBe('That handle is reserved.');
    }
  });

  it('never accepts anything outside the pattern', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (handleProblem(s) === null) expect(HANDLE_PATTERN.test(s)).toBe(true);
      }),
    );
  });
});

describe('cleanHandleInput', () => {
  it('lowercases and keeps only ASCII letters, digits and hyphens', () => {
    expect(cleanHandleInput('Ada-Lovelace')).toBe('ada-lovelace');
    expect(cleanHandleInput('ada 🚀 lö_vé!')).toBe('adalv');
    expect(cleanHandleInput('İstanbul')).toBe('istanbul');
  });

  it('only ever yields characters a handle may hold', () => {
    fc.assert(fc.property(fc.string({ unit: 'binary' }), (s) => /^[a-z0-9-]*$/.test(cleanHandleInput(s))));
  });
});

describe('shownHandle', () => {
  it('puts [bot] at the end of a bot’s handle, and leaves a person’s alone', () => {
    expect(shownHandle('openreview', true)).toBe('openreview[bot]');
    expect(shownHandle('ada', false)).toBe('ada');
  });
});
