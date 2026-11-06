import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { handleProblem, HANDLE_PATTERN } from '@/lib/profile';

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
