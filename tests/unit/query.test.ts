import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  containsPattern,
  MAX_SEARCH_TERMS,
  parseSearch,
  prefixOf,
  requiredText,
  websearchOf,
  type SearchNode,
} from '@/lib/query';

const text = (include: string[], exclude: string[] = []): SearchNode => ({ kind: 'text', include, exclude });

describe('parseSearch', () => {
  it('merges the words of an AND into one text node', () => {
    const { node, errors } = parseSearch('attention is all you need');
    expect(errors).toEqual([]);
    expect(node).toEqual(text(['attention', 'is', 'all', 'you', 'need']));
  });

  it('keeps phrases quoted and negations on their side', () => {
    expect(parseSearch('graph "neural net" -tree -"decision forest"').node).toEqual(
      text(['graph', '"neural net"'], ['tree', '"decision forest"']),
    );
    expect(parseSearch('`back ticks`').node).toEqual(text(['"back ticks"']));
  });

  it('reads known fields with every operator and alias', () => {
    const { node, fields } = parseSearch('author:hinton t:"deep nets" y>=2020 year!=2021 v:iclr a!=smith');
    expect(node).toEqual({
      kind: 'and',
      items: [
        { kind: 'match', field: 'author', op: '=', value: 'hinton' },
        { kind: 'match', field: 'title', op: '=', value: 'deep nets' },
        { kind: 'compare', field: 'year', op: '>=', value: '2020' },
        { kind: 'compare', field: 'year', op: '!=', value: '2021' },
        { kind: 'match', field: 'venue', op: '=', value: 'iclr' },
        { kind: 'match', field: 'author', op: '!=', value: 'smith' },
      ],
    });
    expect([...fields].sort()).toEqual(['author', 'title', 'venue', 'year']);
  });

  it('treats an unknown key as text', () => {
    expect(parseSearch('BERT: pre-training').node).toEqual(text(['BERT:', 'pre-training']));
    expect(parseSearch('http://x.org').node).toEqual(text(['http://x.org']));
  });

  it('drops a bad filter with an error, keeping the rest', () => {
    const { node, errors } = parseSearch('graph year>abc year>20260 title>x author:');
    expect(node).toEqual(text(['graph']));
    expect(errors).toHaveLength(4);
  });

  it('reads key:>n as key>n, on number fields only', () => {
    expect(parseSearch('year:>2020').node).toEqual({ kind: 'compare', field: 'year', op: '>', value: '2020' });
    expect(parseSearch('year:=2020').node).toEqual({ kind: 'compare', field: 'year', op: '=', value: '2020' });
    expect(parseSearch('title:<x').node).toEqual({ kind: 'match', field: 'title', op: '=', value: '<x' });
    expect(parseSearch('year:>').errors).toHaveLength(1);
  });

  it('groups with OR and parentheses', () => {
    expect(parseSearch('(venue:iclr OR venue:neurips) diffusion').node).toEqual({
      kind: 'and',
      items: [
        text(['diffusion']),
        {
          kind: 'or',
          items: [
            { kind: 'match', field: 'venue', op: '=', value: 'iclr' },
            { kind: 'match', field: 'venue', op: '=', value: 'neurips' },
          ],
        },
      ],
    });
    expect(parseSearch('a or b').node).toEqual({ kind: 'or', items: [text(['a']), text(['b'])] });
  });

  it('negates filters and groups, and a multi-word group is "not both"', () => {
    expect(parseSearch('-venue:iclr').node).toEqual({
      kind: 'not',
      item: { kind: 'match', field: 'venue', op: '=', value: 'iclr' },
    });
    expect(parseSearch('-(a b)').node).toEqual({ kind: 'not', item: text(['a', 'b']) });
    expect(parseSearch('-(a)').node).toEqual(text([], ['a']));
  });

  it('forgives unbalanced parentheses, dangling ORs and lone dashes', () => {
    expect(parseSearch('a) b').node).toEqual(text(['a', 'b']));
    expect(parseSearch('(a OR b').node).toEqual({ kind: 'or', items: [text(['a']), text(['b'])] });
    expect(parseSearch('OR a OR').node).toEqual(text(['a']));
    expect(parseSearch('a - b').node).toEqual(text(['a', 'b']));
    expect(parseSearch('()').node).toBeNull();
    expect(parseSearch('--a').node).toEqual(text([], ['a']));
  });

  it('never throws, and never lets a quote into a word', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const { node } = parseSearch(s);
        const walk = (n: SearchNode): void => {
          if (n.kind === 'and' || n.kind === 'or') n.items.forEach(walk);
          else if (n.kind === 'not') walk(n.item);
          else if (n.kind === 'text') {
            for (const f of [...n.include, ...n.exclude]) {
              // A phrase is one quoted run; a word has no quote and no leading dash.
              expect(f).toMatch(/^("[^"]+"|[^"\s-][^"\s]*)$/);
            }
          } else if (n.kind === 'compare') expect(n.value).toMatch(/^\d+$/);
        };
        if (node) walk(node);
      }),
    );
  });
});

describe('the term cap', () => {
  const leaves = (n: SearchNode | null): number =>
    n === null
      ? 0
      : n.kind === 'and' || n.kind === 'or'
        ? n.items.reduce((s, i) => s + leaves(i), 0)
        : n.kind === 'not'
          ? leaves(n.item)
          : 1;

  it('keeps the first terms of a long OR chain and says so', () => {
    const words = Array.from({ length: 38 }, (_, i) => `x${i}`);
    const { node, errors } = parseSearch(words.join(' OR '));
    expect(leaves(node)).toBe(MAX_SEARCH_TERMS);
    expect(node).toEqual({ kind: 'or', items: words.slice(0, MAX_SEARCH_TERMS).map((w) => text([w])) });
    expect(errors).toEqual([`${38 - MAX_SEARCH_TERMS} more terms: at most ${MAX_SEARCH_TERMS} are used`]);
  });
  it('counts a long plain query as one term', () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i}`);
    const { node, errors } = parseSearch(words.join(' '));
    expect(errors).toEqual([]);
    expect(node).toEqual(text(words));
  });
  it('forgets a dropped filter, so the page keeps its own', () => {
    const { fields } = parseSearch(
      `${Array.from({ length: MAX_SEARCH_TERMS }, (_, i) => `t:a${i}`).join(' ')} venue:iclr`,
    );
    expect(fields.has('venue')).toBe(false);
    expect(fields.has('title')).toBe(true);
  });
  it('never leaves more than the cap', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        expect(leaves(parseSearch(s).node)).toBeLessThanOrEqual(MAX_SEARCH_TERMS);
      }),
    );
  });
});

describe('reading the tree', () => {
  it('websearchOf and prefixOf', () => {
    expect(websearchOf({ include: ['a', '"b c"'], exclude: ['d'] })).toBe('a "b c" -d');
    expect(prefixOf({ include: ['attention', 'transf'], exclude: [] })).toBe('attention & transf:*');
    expect(prefixOf({ include: ['a'], exclude: ['d'] })).toBeNull();
    expect(prefixOf({ include: ['"a b"'], exclude: [] })).toBeNull();
  });

  it('requiredText is the root text or a root AND’s', () => {
    expect(requiredText(parseSearch('graph year>2020').node)).toEqual(text(['graph']));
    expect(requiredText(parseSearch('graph').node)).toEqual(text(['graph']));
    expect(requiredText(parseSearch('graph OR year>2020').node)).toBeNull();
    expect(requiredText(parseSearch('-graph year>2020').node)).toBeNull();
    expect(requiredText(parseSearch('year>2020').node)).toBeNull();
    expect(requiredText(null)).toBeNull();
  });

  it('containsPattern escapes LIKE metacharacters', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});
