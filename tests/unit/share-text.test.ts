import { describe, expect, it } from 'vitest';
import { plainText } from '@/server/share';

describe('plainText', () => {
  it('drops Markdown marks and TeX commands, keeping the words', () => {
    expect(plainText('I work on **efficient attention**, $O(n \\log n)$, see [my site](https://x.y).\n\n# More')).toBe(
      'I work on efficient attention, O(n log n), see my site. More',
    );
  });
});
