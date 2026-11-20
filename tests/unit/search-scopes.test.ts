import { describe, expect, it } from 'vitest';
import { parseSearch, positiveText, type SearchNode } from '@/lib/query';
import { MARK_END, MARK_START, snippetParts } from '@/lib/search';
import { fileTypeOf, indexFile, PAGE_SCHEMA_NAMES, searchScopeOf, sectionText } from '@/server/pages/schemas';

const text = (include: string[], exclude: string[] = []): SearchNode => ({ kind: 'text', include, exclude });

describe('in: scopes', () => {
  it('looks in titles and abstracts without one', () => {
    expect([...parseSearch('attention').scopes]).toEqual(['paper']);
  });

  it('reads in:page, in:reviews and in:all, adding up, wherever they are written', () => {
    const { node, scopes, errors } = parseSearch('data in:reviews (leakage OR contamination) in:page');
    expect(errors).toEqual([]);
    expect([...scopes].sort()).toEqual(['page', 'reviews']);
    expect(node).toEqual({
      kind: 'and',
      items: [text(['data']), { kind: 'or', items: [text(['leakage']), text(['contamination'])] }],
    });
    expect([...parseSearch('IN:All x').scopes].sort()).toEqual(['page', 'paper', 'reviews']);
    expect([...parseSearch('in:review x').scopes]).toEqual(['reviews']);
  });

  it('refuses an unknown scope or a negated one, and keeps the rest', () => {
    const unknown = parseSearch('in:comments x');
    expect(unknown.errors).toHaveLength(1);
    expect([...unknown.scopes]).toEqual(['paper']);
    expect(unknown.node).toEqual(text(['x']));
    expect(parseSearch('-in:reviews x').errors).toHaveLength(1);
    expect(parseSearch('in=reviews x').errors).toHaveLength(1);
  });

  it("isn't a term, so it doesn't count toward the cap", () => {
    expect(parseSearch('in:page in:reviews in:all a OR b OR c OR d OR e OR f OR g OR h').errors).toEqual([]);
  });

  it('collects the words a snippet should mark, outside negations', () => {
    const { node } = parseSearch('a -b (c OR -(d e)) title:x');
    expect(positiveText(node)).toEqual([
      { include: ['a'], exclude: [] },
      { include: ['c'], exclude: [] },
    ]);
  });
});

describe('sections in the registry', () => {
  it('are a text type, searched in the page, with no JSON Schema', () => {
    expect(fileTypeOf('owners/10-tl-dr.md')).toBe('section');
    expect(fileTypeOf('community/20-results.html')).toBe('section');
    expect(fileTypeOf('community/x.md')).toBeNull();
    expect(searchScopeOf('community/10-summary.md')).toBe('page');
    expect(searchScopeOf('reviews/openreview/x/notes/y.json')).toBe('reviews');
    expect(searchScopeOf('.potentialpaper/pdf.json')).toBeNull();
    expect(PAGE_SCHEMA_NAMES).not.toContain('section');
  });

  it('index their words with their title and part, and skip blank ones', () => {
    expect(
      indexFile('owners/10-tl-dr.md', '# In short\n\nSee [the code](https://x.org) and ![a plot](p.png).\n'),
    ).toEqual([
      { kind: 'section', text: 'In short\n\nSee the code and a plot.', fields: { part: 'owners', title: 'In short' } },
    ]);
    expect(indexFile('community/10-a.html', '<h1>Results</h1><p>Fast &amp; <em>small</em>.</p>')).toEqual([
      { kind: 'section', text: 'Results Fast & small .', fields: { part: 'community', title: 'Results' } },
    ]);
    expect(indexFile('community/10-summary.md', ' \n')).toEqual([]);
  });

  it('strip Markdown emphasis but keep math, code and snake_case', () => {
    expect(sectionText('**bold** *it* ~~no~~ $x^2$ `a*b` snake_case_name', false)).toBe(
      'bold it no $x^2$ `a*b` snake_case_name',
    );
  });
});

describe('snippetParts', () => {
  it('splits a snippet into plain and marked runs', () => {
    expect(snippetParts(`a ${MARK_START}b${MARK_END} c`)).toEqual([
      { text: 'a ', marked: false },
      { text: 'b', marked: true },
      { text: ' c', marked: false },
    ]);
  });
});
