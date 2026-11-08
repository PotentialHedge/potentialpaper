import katex from 'katex';
import MarkdownIt, { type StateBlock, type StateInline } from 'markdown-it';
import {
  DEMO_ALLOW,
  DEMO_SANDBOX,
  demoBlockId,
  demoBlockText,
  demoUrl,
  sourceAt,
  sourceLabel,
  type DemoSource,
} from '@/lib/demos';

/**
 * A page's Markdown, as HTML and as sections. Rendered once, at commit (`writeCurrent`), so readers are
 * served stored HTML. Raw HTML is off, so the only tags are markdown-it's own and KaTeX's, and
 * markdown-it's `validateLink` refuses `javascript:`, `vbscript:`, `file:` and non-image `data:` links.
 * The CSP is the second lock (`next.config.ts`).
 *
 * A ```` ```demo <snapshot> ```` block is a demo (`lib/demos.ts`), shown as a figure with its frame. Where its
 * files came from is looked up when rendering, and a block naming no known snapshot says so.
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

type RenderEnv = { demos?: ReadonlyMap<string, DemoSource> } & Record<string, unknown>;

/**
 * A demo's figure. The frame has no `src` until it nears the screen: `DemoFrames` gives it one, fits its
 * height to what the demo reports, and runs the full-screen button.
 */
function renderDemo(id: string, body: string, demo: DemoSource | undefined, escape: (s: string) => string): string {
  const { title, description } = demoBlockText(body);
  const name = escape(title || 'Untitled demo');
  if (!demo) return `<p class="demo-missing">A demo, “${name}”, that isn't on this site.</p>\n`;
  const url = escape(demoUrl(id));
  return [
    `<figure class="demo" data-demo="${id}">`,
    `<iframe class="demo-frame" data-src="${url}" title="${name}" sandbox="${DEMO_SANDBOX}" allow="${DEMO_ALLOW}" allowfullscreen></iframe>`,
    `<figcaption><b>Demo:</b> ${name}${description ? `. ${escape(description)}` : ''}`,
    `<span class="demo-tools"><button type="button" data-demo-fullscreen>full screen</button>`,
    `<a href="${url}" target="_blank" rel="noopener">new tab</a>`,
    `<a href="${escape(sourceAt(demo))}" rel="nofollow ugc noopener" class="demo-source">${escape(sourceLabel(demo))}</a></span>`,
    `</figcaption></figure>\n`,
  ].join('');
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

  const fence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env: RenderEnv | undefined, self) => {
    const id = demoBlockId(tokens[idx].info);
    if (!id) return fence(tokens, idx, options, env, self);
    return renderDemo(id, tokens[idx].content, env?.demos?.get(id), md.utils.escapeHtml);
  };

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

/** What an empty section starts as, in the editor. */
export const STARTER_HEADINGS = ['Summary', 'Why it matters', 'Critique', 'Errata', 'Reproductions', 'Follow-ups'];
export const COMMUNITY_STARTER = STARTER_HEADINGS.map((title) => `## ${title}\n`).join('\n');
export const AUTHOR_STARTER_HEADINGS = ['TL;DR', 'Overview', 'Results', 'Demos', 'Code and data', 'Talks'];
export const AUTHOR_STARTER = AUTHOR_STARTER_HEADINGS.map((title) => `## ${title}\n`).join('\n');

/**
 * HTML for a page's Markdown. Headings move down a level, since the page's own section heading is the
 * `<h2>`, and each section's heading carries `data-section`, so a page can give it an edit link. The ids
 * start with `idPrefix`, so the author and community sections can't collide.
 */
export function renderMarkdown(
  markdown: string,
  idPrefix = 'md',
  demos: ReadonlyMap<string, DemoSource> = new Map(),
): string {
  const env: RenderEnv = { demos };
  const tokens = md.parse(markdown, env);
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
  return md.renderer.render(tokens, md.options, env);
}

/** The same, for HTML stored beside Markdown that may be absent. */
export function renderOrNull(
  markdown: string | null,
  idPrefix: string,
  demos?: ReadonlyMap<string, DemoSource>,
): string | null {
  return markdown === null || markdown.trim() === '' ? null : renderMarkdown(markdown, idPrefix, demos);
}

/** The snapshots the Markdown's demo blocks name, in order, each once. */
export function demoIds(markdown: string | null): string[] {
  if (!markdown) return [];
  const ids = md
    .parse(markdown, {})
    .filter((token) => token.type === 'fence')
    .map((token) => demoBlockId(token.info))
    .filter((id): id is string => id !== null);
  return [...new Set(ids)];
}
