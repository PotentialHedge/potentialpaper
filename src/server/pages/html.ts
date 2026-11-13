import sanitizeHtml from 'sanitize-html';

/**
 * A section written in HTML (`author/20-results.html`). People write these, so what they may use is an
 * allowlist: text structure, tables, links and images, and no scripts, styles, forms, frames, event handlers,
 * ids or classes (an id could shadow the page's own). A file with anything else is refused at commit
 * (`htmlProblem`), rather than quietly cleaned, because a pushed commit is stored as it was sent, so what is
 * in the repo has to be what is shown. The renderer still runs the same allowlist, as a second lock.
 */

const TAGS = [
  'p',
  'br',
  'hr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'code',
  'em',
  'strong',
  'b',
  'i',
  'u',
  's',
  'sub',
  'sup',
  'small',
  'mark',
  'kbd',
  'samp',
  'var',
  'q',
  'cite',
  'abbr',
  'dfn',
  'del',
  'ins',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'a',
  'img',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'span',
  'div',
  'details',
  'summary',
  'time',
];
const EVERYWHERE = ['title', 'lang', 'dir'];
const ATTRIBUTES: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt'],
  th: ['colspan', 'rowspan', 'scope'],
  td: ['colspan', 'rowspan'],
  ol: ['start', 'reversed'],
  time: ['datetime'],
  details: ['open'],
};
/** Which schemes an address may have. Relative addresses (`/abs/1706.03762`, `#x`) are always fine. */
const SCHEMES: Record<string, string[]> = { href: ['http', 'https', 'mailto'], src: ['https'] };

/** The scheme an address names, as a browser would read it: blanks and control characters inside don't count. */
function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\u0000-\u0020\u007f]+/g, ''));
  return match ? match[1].toLowerCase() : null;
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: TAGS,
  // `rel` and `loading` are the renderer's own, added below; `htmlProblem` refuses them from a person.
  allowedAttributes: { '*': EVERYWHERE, ...ATTRIBUTES, a: ['href', 'rel'], img: ['src', 'alt', 'loading'] },
  allowedSchemes: SCHEMES.href,
  allowedSchemesByTag: { img: SCHEMES.src },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    // Someone else's words: no ranking passed on, no opener handed over (as `markdown.ts` does).
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'nofollow ugc noopener' } }),
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
  },
};

/** What in the HTML isn't allowed, or `null`. Said once, for the first thing found. */
export function htmlProblem(html: string): string | null {
  let problem: string | null = null;
  sanitizeHtml(html, {
    ...OPTIONS,
    onOpenTag(name, attribs) {
      if (problem) return;
      if (!TAGS.includes(name)) {
        problem = `has a <${name}> element, which sections can't use`;
        return;
      }
      for (const [attribute, value] of Object.entries(attribs)) {
        if (!EVERYWHERE.includes(attribute) && !(ATTRIBUTES[name] ?? []).includes(attribute)) {
          problem = `has a “${attribute}” attribute on <${name}>, which sections can't use`;
          return;
        }
        const allowed = SCHEMES[attribute];
        const scheme = allowed ? schemeOf(value) : null;
        if (allowed && scheme !== null && !allowed.includes(scheme)) {
          problem = `has a ${scheme}: address in <${name}>, which sections can't use`;
          return;
        }
        if (allowed && /^\s*\/\//.test(value)) {
          problem = `has an address starting with // in <${name}>; write https:`;
          return;
        }
      }
    },
  });
  return problem;
}

/** The HTML with only what the allowlist keeps. */
export function sanitizeSectionHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}

const LEADING_H1 = /^\s*<h1(?:\s[^>]*)?>([\s\S]*?)<\/h1>/;

/** The text of the `<h1>` an HTML section starts with, or `null`. */
export function leadingHtmlTitle(html: string): string | null {
  const match = LEADING_H1.exec(sanitizeSectionHtml(html));
  return match ? decodeText(match[1].replace(/<[^>]*>/g, '')).trim() : null;
}

function decodeText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * An HTML section as the page shows it, as `renderMarkdown` does a Markdown one: its leading `<h1>` (or
 * else `title`) is the section's `<h3>`, with `data-section`, and the headings under it move down two
 * levels. The allowlist leaves headings no attributes but title, lang and dir, so these patterns see all.
 */
export function renderHtmlSection(html: string, idPrefix: string, index: number, title: string): string {
  const clean = sanitizeSectionHtml(html);
  const lead = LEADING_H1.exec(clean);
  const heading = lead ? lead[1] : escapeText(title);
  const rest = shiftHeadings(lead ? clean.slice(lead[0].length) : clean);
  return `<h3 id="${idPrefix}-${index}" data-section="${index}">${heading}</h3>\n${rest.trim()}\n`;
}

/** HTML as the editor's preview shows it, a section's own heading included. */
export function renderHtml(html: string): string {
  return shiftHeadings(sanitizeSectionHtml(html));
}

function shiftHeadings(clean: string): string {
  return clean.replace(
    /<(\/?)h([1-6])\b/g,
    (_, slash: string, level: string) => `<${slash}h${Math.min(6, Number(level) + 2)}`,
  );
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
