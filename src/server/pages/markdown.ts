import katex from 'katex';
import MarkdownIt, { type StateBlock, type StateInline, type Token } from 'markdown-it';
import {
  DEMO_ALLOW,
  DEMO_SANDBOX,
  demoBlockRef,
  demoBlockText,
  demoRefKey,
  demoUrl,
  parseDemoInfo,
  sourceAt,
  sourceLabel,
  type DemoRef,
  type DemoSource,
} from '@/lib/demos';

/**
 * A page's Markdown, as HTML and as sections. Rendered once, at commit (`writeCurrent`), so readers are
 * served stored HTML. Raw HTML is off, so the only tags are markdown-it's own and KaTeX's, and
 * markdown-it's `validateLink` refuses `javascript:`, `vbscript:`, `file:` and non-image `data:` links.
 * The CSP is the second lock (`next.config.ts`).
 *
 * A ```` ```demo <name> ```` block is a demo (`lib/demos.ts`), shown as a figure with its frame. The snapshot
 * each name stands for, and where its files came from, are looked up before rendering (`demos/attach.ts`),
 * and a block whose demo isn't found says so.
 *
 * A page's part (author or community) is a directory of section files (`rules.ts`), and a section's
 * title is the `#` heading its file starts with. The whole part as one text, which the editor offers, is
 * the files joined, and it is split back at its top-level `#` headings, from the same parse that renders
 * them, so the two can't disagree.
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

/** What a block says when its demo isn't on the site, as in a preview of a demo not yet copied. */
function missingDemo(ref: DemoRef, name: string, escape: (s: string) => string): string {
  const where =
    ref.kind === 'github'
      ? `from ${escape(ref.url)}, which is copied when the edit is saved`
      : ref.kind === 'repo'
        ? `from this page's ${escape(demoRefKey(ref))}`
        : "that isn't on this site";
  return `<p class="demo-missing">A demo, “${name}”, ${where}.</p>\n`;
}

/**
 * A demo's figure. The frame has no `src` until it nears the screen: `DemoFrames` gives it one, fits its
 * height to what the demo reports, and runs the full-screen button.
 */
function renderDemo(ref: DemoRef, body: string, demo: DemoSource | undefined, escape: (s: string) => string): string {
  const { title, description } = demoBlockText(body);
  const name = escape(title || 'Untitled demo');
  if (!demo) return missingDemo(ref, name, escape);
  const url = escape(demoUrl(demo.id));
  const at = sourceAt(demo);
  const label = escape(sourceLabel(demo));
  return [
    `<figure class="demo" data-demo="${demo.id}">`,
    `<iframe class="demo-frame" data-src="${url}" title="${name}" sandbox="${DEMO_SANDBOX}" allow="${DEMO_ALLOW}" allowfullscreen></iframe>`,
    `<figcaption><b>Demo:</b> ${name}${description ? `. ${escape(description)}` : ''}`,
    `<span class="demo-tools"><button type="button" data-demo-fullscreen>full screen</button>`,
    `<a href="${url}" target="_blank" rel="noopener">new tab</a>`,
    at
      ? `<a href="${escape(at)}" rel="nofollow ugc noopener" class="demo-source">${label}</a>`
      : `<span class="demo-source">${label}</span>`,
    `</span></figcaption></figure>\n`,
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
    const ref = demoBlockRef(tokens[idx].info);
    if (!ref) return fence(tokens, idx, options, env, self);
    return renderDemo(ref, tokens[idx].content, env?.demos?.get(demoRefKey(ref)), md.utils.escapeHtml);
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

/** A section heading: `#` at the top level, not a setext `===` line, which people rarely mean as one. */
function isSectionHeading(token: Token): boolean {
  return token.type === 'heading_open' && token.tag === 'h1' && token.markup === '#' && token.level === 0;
}

/** The top-level `#` headings: the line each starts on, and its text. */
function headings(markdown: string): { line: number; title: string }[] {
  const tokens = md.parse(markdown, {});
  const found: { line: number; title: string }[] = [];
  for (const [index, token] of tokens.entries()) {
    if (isSectionHeading(token) && token.map) {
      found.push({ line: token.map[0], title: tokens[index + 1]?.content ?? '' });
    }
  }
  return found;
}

export interface SectionText {
  /** Its `#` heading's text, or `null` for text before the first heading. */
  title: string | null;
  /** Its heading line and everything to the next heading, ending in a newline. */
  text: string;
}

/** Text that ends in exactly one newline, unless it is empty, so that sections join cleanly. */
export function asBlock(text: string): string {
  const trimmed = text.replace(/\s+$/, '');
  return trimmed === '' ? '' : `${trimmed}\n`;
}

/** The text cut at each top-level `#` heading, blank parts left out. Joined back together they are the text. */
export function splitSections(markdown: string): SectionText[] {
  const lines = markdown.split(/(?<=\n)/);
  const found = headings(markdown);
  const starts = [0, ...found.map((heading) => heading.line), lines.length];
  const titles = [null, ...found.map((heading) => heading.title)];
  const parts: SectionText[] = [];
  for (let i = 0; i < starts.length - 1; i += 1) {
    const text = lines.slice(starts[i], starts[i + 1]).join('');
    if (text.trim() !== '' || titles[i] !== null) parts.push({ title: titles[i], text });
  }
  return parts;
}

/** The title a section file starts with, or `null` if it doesn't start with a `#` heading. */
export function leadingTitle(markdown: string): string | null {
  const tokens = md.parse(markdown, {});
  return tokens[0] && isSectionHeading(tokens[0]) ? (tokens[1]?.content ?? '') : null;
}

/** What an empty part starts as, in the editor: a heading for each section it might have. */
export const STARTER_HEADINGS = ['Summary', 'Why it matters', 'Critique', 'Errata', 'Reproductions', 'Follow-ups'];
export const COMMUNITY_STARTER = STARTER_HEADINGS.map((title) => `# ${title}\n`).join('\n');
export const AUTHOR_STARTER_HEADINGS = ['TL;DR', 'Overview', 'Results', 'Demos', 'Code and data', 'Talks'];
export const AUTHOR_STARTER = AUTHOR_STARTER_HEADINGS.map((title) => `# ${title}\n`).join('\n');

export interface RenderOptions {
  demos?: ReadonlyMap<string, DemoSource>;
  /**
   * Render one section file as section `section`: only its leading `#` heading is the section's, and a
   * file without one gets `title` as its heading. Without it, every top-level `#` is a section, from 1.
   */
  section?: { index: number; title: string };
}

/**
 * HTML for Markdown. Headings move down two levels, since the page's own part heading is the `<h2>` and a
 * section's is the `<h3>`, and each section's heading carries `data-section`, so a page can give it an edit
 * link. The ids start with `idPrefix`, so the author and community sections can't collide.
 */
export function renderMarkdown(markdown: string, idPrefix = 'md', options: RenderOptions = {}): string {
  const env: RenderEnv = { demos: options.demos ?? new Map() };
  const tokens = md.parse(markdown, env);
  const only = options.section;
  let section = only ? only.index - 1 : 0;
  let lead = '';
  if (only && !(tokens[0] && isSectionHeading(tokens[0]))) {
    lead = `<h3 id="${idPrefix}-${only.index}" data-section="${only.index}">${md.utils.escapeHtml(only.title)}</h3>\n`;
  }
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'heading_open' && token.type !== 'heading_close') continue;
    const isSection = isSectionHeading(token) && (!only || index === 0);
    token.tag = `h${Math.min(6, Number(token.tag.slice(1)) + 2)}`;
    if (isSection) {
      section += 1;
      token.attrSet('id', `${idPrefix}-${section}`);
      token.attrSet('data-section', String(section));
    }
  }
  return lead + md.renderer.render(tokens, md.options, env);
}

/** The demos the Markdown's blocks name, in order, each once (by `demoRefKey`). */
export function demoRefs(markdown: string | null): DemoRef[] {
  if (!markdown) return [];
  const found = new Map<string, DemoRef>();
  for (const token of md.parse(markdown, {})) {
    const ref = token.type === 'fence' ? demoBlockRef(token.info) : null;
    if (ref && !found.has(demoRefKey(ref))) found.set(demoRefKey(ref), ref);
  }
  return [...found.values()];
}

/** The snapshot ids the Markdown's blocks name directly. */
export function demoIds(markdown: string | null): string[] {
  return demoRefs(markdown).flatMap((ref) => (ref.kind === 'snapshot' ? [ref.id] : []));
}

/** Why a block that starts ```` ```demo ```` names no demo, for each such block, so a commit can refuse it. */
export function demoBlockProblems(markdown: string): string[] {
  return md.parse(markdown, {}).flatMap((token) => {
    const parsed = token.type === 'fence' ? parseDemoInfo(token.info) : null;
    return parsed && 'problem' in parsed ? [parsed.problem] : [];
  });
}

/**
 * The text with its top-level `#` headings moved by `delta` levels (`##` is `#` moved by 1), between 1 and
 * 6. Only headings markdown-it sees as such: a `#` in code or a quote stays as it is.
 */
export function shiftHeadings(markdown: string, delta: number): string {
  const lines = markdown.split(/(?<=\n)/);
  for (const token of md.parse(markdown, {})) {
    if (token.type !== 'heading_open' || token.level !== 0 || !token.markup.startsWith('#') || !token.map) continue;
    const at = token.map[0];
    lines[at] = lines[at].replace(/^( {0,3})(#{1,6})/, (_, indent: string, hashes: string) => {
      return indent + '#'.repeat(Math.min(6, Math.max(1, hashes.length + delta)));
    });
  }
  return lines.join('');
}
