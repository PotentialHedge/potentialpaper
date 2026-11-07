import katex from 'katex';
import MarkdownIt, { type StateBlock, type StateInline } from 'markdown-it';

/**
 * A page's Markdown, as HTML and as sections. Rendered once, at commit (`writeCurrent`), so readers are
 * served stored HTML. Raw HTML is off, so the only tags are markdown-it's own and KaTeX's, and
 * markdown-it's `validateLink` refuses `javascript:`, `vbscript:`, `file:` and non-image `data:` links.
 * The CSP is the second lock (`next.config.ts`).
 *
 * Sections are the `##` headings at the top level, numbered from 1 in order. The editor splits a file at
 * them and the rendered page marks them, both from the same parse, so the two can't disagree.
 */

const MATH_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  // `\href`, `\url`, `\htmlClass` and the like stay text: KaTeX's own links would skip markdown-it's checks.
  trust: false,
  strict: 'ignore',
  maxSize: 20,
  maxExpand: 500,
  output: 'htmlAndMathml',
};

function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, { ...MATH_OPTIONS, displayMode });
}

/** `$…$`, as Pandoc reads it: no space inside either `$`, and no digit straight after the closing one. */
function inlineMath(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state;
  if (src.charCodeAt(pos) !== 0x24 /* $ */ || src.charCodeAt(pos + 1) === 0x24) return false;
  const first = src[pos + 1];
  if (first === undefined || /\s/.test(first)) return false;
  let end = pos + 1;
  for (;;) {
    end = src.indexOf('$', end);
    if (end === -1) return false;
    if (src[end - 1] === '\\') {
      end += 1;
      continue;
    }
    break;
  }
  if (/\s/.test(src[end - 1]) || /\d/.test(src[end + 1] ?? '')) return false;
  if (!silent) {
    const token = state.push('math_inline', 'math', 0);
    token.content = src.slice(pos + 1, end);
    token.markup = '$';
  }
  state.pos = end + 1;
  return true;
}

/** A `$$` block: from a line starting `$$` to one ending `$$`, which may be the same line. */
function blockMath(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const lineText = (line: number) => state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  const opening = lineText(startLine);
  if (!opening.startsWith('$$')) return false;
  const parts: string[] = [];
  let line = startLine;
  let rest = opening.slice(2).trim();
  while (!rest.endsWith('$$')) {
    parts.push(rest);
    line += 1;
    if (line >= endLine || (state.sCount[line] < state.blkIndent && lineText(line) !== '')) return false;
    rest = lineText(line).trim();
  }
  parts.push(rest.slice(0, -2));
  if (silent) return true;
  state.line = line + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = parts.filter((part) => part !== '').join('\n');
  token.map = [startLine, state.line];
  token.markup = '$$';
  return true;
}

function newRenderer() {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.inline.ruler.after('escape', 'math_inline', inlineMath);
  md.block.ruler.after('blockquote', 'math_block', blockMath, {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  md.renderer.rules.math_inline = (tokens, idx) => renderMath(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) =>
    `<div class="math-display">${renderMath(tokens[idx].content, true)}</div>\n`;

  const renderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.rules.link_open = (tokens, idx, options) => {
    // Someone else's words: no ranking passed on, no opener handed over.
    tokens[idx].attrSet('rel', 'nofollow ugc noopener');
    return renderToken(tokens, idx, options);
  };
  return md;
}

const md = newRenderer();

/** The top-level `##` headings: the line each starts on, and its text. */
function headings(markdown: string): { line: number; title: string }[] {
  const tokens = md.parse(markdown, {});
  const found: { line: number; title: string }[] = [];
  for (const [index, token] of tokens.entries()) {
    if (
      token.type === 'heading_open' &&
      token.tag === 'h2' &&
      token.markup === '##' &&
      token.level === 0 &&
      token.map
    ) {
      found.push({ line: token.map[0], title: tokens[index + 1]?.content ?? '' });
    }
  }
  return found;
}

export interface Section {
  /** From 1, in order. */
  index: number;
  title: string;
  /** Its heading line and everything to the next section, ending in a newline. */
  text: string;
}

/** The text before the first section, and the sections. Joined back together they are the file. */
export function splitSections(markdown: string): { preamble: string; sections: Section[] } {
  const lines = markdown.split(/(?<=\n)/);
  const found = headings(markdown);
  const starts = [...found.map((heading) => heading.line), lines.length];
  return {
    preamble: lines.slice(0, starts[0]).join(''),
    sections: found.map((heading, i) => ({
      index: i + 1,
      title: heading.title,
      text: lines.slice(starts[i], starts[i + 1]).join(''),
    })),
  };
}

/** Text that ends in exactly one newline, unless it is empty, so that sections join cleanly. */
function asBlock(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed === '' ? '' : `${trimmed}\n`;
}

/**
 * The file with one section replaced, or `null` if it has no section `index`. Section 0 is the whole
 * file. A section separated from the next by a blank line keeps it.
 */
export function replaceSection(markdown: string, index: number, content: string): string | null {
  if (index === 0) return asBlock(content);
  const { preamble, sections } = splitSections(markdown);
  const target = sections[index - 1];
  if (!target) return null;
  const parts = [preamble, ...sections.map((section) => section.text)];
  const gap = /\n\s*\n$/.test(target.text) && index < sections.length ? '\n' : '';
  const next = asBlock(content);
  parts[index] = next === '' ? '' : `${next}${gap}`;
  return parts.join('');
}

/** What an empty community section starts as, in the editor. */
export const STARTER_HEADINGS = ['Summary', 'Why it matters', 'Critique', 'Errata', 'Reproductions', 'Follow-ups'];
export const COMMUNITY_STARTER = STARTER_HEADINGS.map((title) => `## ${title}\n`).join('\n');

/**
 * HTML for a page's Markdown. Headings move down a level, since the page's own section heading is the
 * `<h2>`, and each section's heading carries `data-section`, so a page can give it an edit link. The ids
 * start with `idPrefix`, so the author and community sections can't collide.
 */
export function renderMarkdown(markdown: string, idPrefix = 'md'): string {
  const tokens = md.parse(markdown, {});
  let section = 0;
  for (const token of tokens) {
    if (token.type !== 'heading_open' && token.type !== 'heading_close') continue;
    const level = Math.min(6, Number(token.tag.slice(1)) + 1);
    const isSection = token.tag === 'h2' && token.markup === '##' && token.level === 0;
    token.tag = `h${level}`;
    if (token.type === 'heading_open' && isSection) {
      section += 1;
      token.attrSet('id', `${idPrefix}-${section}`);
      token.attrSet('data-section', String(section));
    }
  }
  return md.renderer.render(tokens, md.options, {});
}

/** The same, for HTML stored beside Markdown that may be absent. */
export function renderOrNull(markdown: string | null, idPrefix: string): string | null {
  return markdown === null || markdown.trim() === '' ? null : renderMarkdown(markdown, idPrefix);
}
