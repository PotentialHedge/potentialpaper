import { describe, expect, it } from 'vitest';
import { renderMarkdown, shiftHeadings, splitSections } from '@/server/pages/markdown';

const PAGE = `Intro.

# Summary
It works.

# Critique
\`\`\`
# not a section
\`\`\`
- one

# Errata
None.
`;

describe('sections', () => {
  it('splits at top-level # headings, not in code, and joins back to the text', () => {
    const parts = splitSections(PAGE);
    expect(parts.map((s) => s.title)).toEqual([null, 'Summary', 'Critique', 'Errata']);
    expect(parts.map((s) => s.text).join('')).toBe(PAGE);
    expect(splitSections('# Only\n').map((s) => s.title)).toEqual(['Only']);
    expect(splitSections('\n\n')).toEqual([]);
  });

  it('moves headings, but not a # in code or a quote', () => {
    const text = '## A\n\n### B\n\n```\n## code\n```\n\n> ## quoted\n';
    expect(shiftHeadings(text, -1)).toBe('# A\n\n## B\n\n```\n## code\n```\n\n> ## quoted\n');
    expect(shiftHeadings('# A\n###### B\n', 2)).toBe('### A\n###### B\n');
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

  it('moves headings down two levels and numbers the sections it splits at', () => {
    const html = renderMarkdown(PAGE, 'community');
    expect(html).toContain('<h3 id="community-1" data-section="1">Summary</h3>');
    expect(html).toContain('<h3 id="community-3" data-section="3">Errata</h3>');
    expect(html).not.toContain('<h2');
    expect(renderMarkdown('## Sub')).toBe('<h4>Sub</h4>\n');
  });

  it("renders one section file: only its leading heading is the section's, or else its name's", () => {
    const one = renderMarkdown('# Results\n\nGood.\n\n# Aside\n', 'author', { section: { index: 2, title: 'X' } });
    expect(one).toContain('<h3 id="author-2" data-section="2">Results</h3>');
    expect(one).toContain('<h3>Aside</h3>');
    const bare = renderMarkdown('Just text.\n', 'author', { section: { index: 1, title: 'Why <it> matters' } });
    expect(bare).toBe('<h3 id="author-1" data-section="1">Why &lt;it&gt; matters</h3>\n<p>Just text.</p>\n');
  });
});
