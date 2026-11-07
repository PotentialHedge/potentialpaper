import { describe, expect, it } from 'vitest';
import { COMMUNITY_STARTER, renderMarkdown, replaceSection, splitSections } from '@/server/pages/markdown';

const PAGE = `Intro.

## Summary
It works.

## Critique
\`\`\`
## not a section
\`\`\`
- one

## Errata
None.
`;

describe('sections', () => {
  it('splits at top-level ## headings, not in code, and joins back to the file', () => {
    const { preamble, sections } = splitSections(PAGE);
    expect(preamble).toBe('Intro.\n\n');
    expect(sections.map((s) => s.title)).toEqual(['Summary', 'Critique', 'Errata']);
    expect(preamble + sections.map((s) => s.text).join('')).toBe(PAGE);
  });

  it('replaces one section and keeps the rest byte for byte', () => {
    const next = replaceSection(PAGE, 2, '## Critique\nToo slow.');
    expect(next).toBe(PAGE.replace(/## Critique[\s\S]*?(?=## Errata)/, '## Critique\nToo slow.\n\n'));
    expect(replaceSection(PAGE, 3, '## Errata\nOne.\n')).toBe(PAGE.replace('None.', 'One.'));
  });

  it('deletes a section given nothing, takes new sections, and refuses one that is not there', () => {
    expect(splitSections(replaceSection(PAGE, 1, '')!).sections.map((s) => s.title)).toEqual(['Critique', 'Errata']);
    const split = replaceSection(PAGE, 1, '## Summary\nA.\n\n## Why it matters\nB.\n')!;
    expect(splitSections(split).sections.map((s) => s.title)).toEqual([
      'Summary',
      'Why it matters',
      'Critique',
      'Errata',
    ]);
    expect(replaceSection(PAGE, 4, 'x')).toBeNull();
    expect(replaceSection(PAGE, 0, 'All new')).toBe('All new\n');
  });

  it('has a starter with the agreed headings', () => {
    expect(splitSections(COMMUNITY_STARTER).sections.map((s) => s.title)).toEqual([
      'Summary',
      'Why it matters',
      'Critique',
      'Errata',
      'Reproductions',
      'Follow-ups',
    ]);
  });
});

describe('rendering', () => {
  it('shows raw HTML as text', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)"> <a href="javascript:x">a</a>',
    );
    expect(html).not.toMatch(/<script|<img|<a /);
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses javascript:, vbscript: and data: links, and marks the rest as someone else’s', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'vbscript:x',
      'data:text/html,<script>x</script>',
    ]) {
      expect(renderMarkdown(`[x](${href})`)).not.toContain('href=');
    }
    expect(renderMarkdown('[x](https://example.org)')).toBe(
      '<p><a href="https://example.org" rel="nofollow ugc noopener">x</a></p>\n',
    );
    expect(renderMarkdown('<https://example.org>')).toContain('rel="nofollow ugc noopener"');
  });

  it('renders math, and keeps KaTeX from making links', () => {
    expect(renderMarkdown('$x^2$')).toContain('class="katex"');
    expect(renderMarkdown('$$\n\\sum_i a_i\n$$')).toContain('class="katex-display"');
    expect(renderMarkdown('It costs $5 and $6.')).not.toContain('katex');
    const href = renderMarkdown('$\\href{javascript:alert(1)}{x}$ $\\url{javascript:alert(1)}$');
    expect(href).not.toMatch(/<a |href="/);
  });

  it('moves headings down a level and numbers the sections it splits at', () => {
    const html = renderMarkdown(PAGE, 'community');
    expect(html).toContain('<h3 id="community-1" data-section="1">Summary</h3>');
    expect(html).toContain('<h3 id="community-3" data-section="3">Errata</h3>');
    expect(html).not.toContain('<h2');
    expect(renderMarkdown('# Top')).toBe('<h2>Top</h2>\n');
  });
});
