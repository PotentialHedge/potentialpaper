import { describe, expect, it } from 'vitest';
import { parseSearch } from '@/lib/query';
import { exampleOf, SEARCH_EXAMPLES } from '@/lib/search-examples';

describe('search examples', () => {
  it('each parses without errors, under an id of its own', () => {
    for (const example of SEARCH_EXAMPLES) expect(parseSearch(example.q).errors).toEqual([]);
    expect(new Set(SEARCH_EXAMPLES.map((e) => e.id)).size).toBe(SEARCH_EXAMPLES.length);
  });

  it('knows a query for an example whatever its spacing, and nothing else', () => {
    const [first] = SEARCH_EXAMPLES;
    expect(exampleOf(`  ${first.q.replace(/ /g, '   ')} `)).toBe(first);
    expect(exampleOf(`${first.q} more`)).toBeNull();
    expect(exampleOf(null)).toBeNull();
  });
});
