import MarkdownIt, { type MarkdownIt as Md, type Token } from 'markdown-it';
import { splitMentions } from '@/lib/aliases';
import { mathPlugin } from '../pages/markdown';

/**
 * A comment's Markdown as HTML, rendered on each read (comments are short, and a mention of the viewer is set
 * apart, so the HTML is the viewer's). The pages' stack (`pages/markdown.ts`): markdown-it with TeX math through
 * KaTeX, `$…$` and `$$…$$`. Safe for anyone's input:
 *
 *   - no raw HTML: markdown-it's `html` is off, so a tag is text;
 *   - links pass markdown-it's `validateLink` (no `javascript:`, `vbscript:`, `file:`, non-image `data:`), open in
 *     a new tab and are marked `nofollow ugc noopener noreferrer`;
 *   - images only as GIFs from {@link GIF_HOSTS}; any other image becomes a plain link to it, so a comment cannot
 *     make every reader's browser fetch a URL of its author's choosing;
 *   - KaTeX runs with `trust: false`, so `\href`, `\url` and friends are inert.
 *
 * Headings are set as bold paragraphs: a comment is not a document, and the page's outline isn't its to change.
 *
 * `known` are the names a `@` may mention on this paper (`server/comments`): each becomes a
 * `<span class="mention">`, and one in `you` (the viewer's own names) also gets `mention-you`. Any other `@word`
 * stays as written, and no `@` in code, math or a link's text is a mention.
 */

/** The one kind of image a comment may embed: an https `.gif` on one of these hosts. */
export const GIF_HOSTS = ['media.giphy.com', 'i.giphy.com', 'media.tenor.com'];

export function gifUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!GIF_HOSTS.includes(u.hostname) || !u.pathname.toLowerCase().endsWith('.gif')) return null;
    return u.href;
  } catch {
    return null;
  }
}

interface CommentEnv {
  known: ReadonlySet<string>;
  you: ReadonlySet<string>;
}

const LINK_REL = 'nofollow ugc noopener noreferrer';

function newRenderer(): Md {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  mathPlugin(md);
  md.core.ruler.push('mentions', (state) => {
    const { known } = state.env as unknown as CommentEnv;
    if (!known || known.size === 0) return;
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      let inLink = 0;
      block.children = block.children.flatMap((child): Token[] => {
        if (child.type === 'link_open') inLink += 1;
        if (child.type === 'link_close') inLink -= 1;
        if (child.type !== 'text' || inLink > 0) return [child];
        return splitMentions(child.content, known).map((part) => {
          if (typeof part === 'string') {
            const text = new state.Token('text', '', 0);
            text.content = part;
            return text;
          }
          const mention = new state.Token('mention', 'span', 0);
          mention.content = part.text;
          mention.meta = { name: part.name };
          return mention;
        });
      });
    }
  });
  md.renderer.rules.mention = (tokens, idx, _options, env) => {
    const { content } = tokens[idx];
    const raw = String(tokens[idx].meta?.name ?? '');
    const name = md.utils.escapeHtml(raw);
    const cls = (env as unknown as CommentEnv).you?.has(raw) ? 'mention mention-you' : 'mention';
    return `<span class="${cls}" data-mention="${name}">${md.utils.escapeHtml(content)}</span>`;
  };

  const renderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.rules.link_open = (tokens, idx, options) => {
    tokens[idx].attrSet('rel', LINK_REL);
    tokens[idx].attrSet('target', '_blank');
    return renderToken(tokens, idx, options);
  };
  md.renderer.rules.image = (tokens, idx, options, env) => {
    const token = tokens[idx];
    const src = String(token.attrGet('src') ?? '');
    const alt = md.renderer.renderInlineAsText(token.children ?? [], options, env);
    const gif = gifUrl(src);
    const e = md.utils.escapeHtml;
    if (gif) return `<img src="${e(gif)}" alt="${e(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
    if (!src) return e(alt);
    return `<a href="${e(src)}" rel="${LINK_REL}" target="_blank">${e(alt || src)}</a>`;
  };
  md.renderer.rules.heading_open = () => '<p class="comment-heading"><strong>';
  md.renderer.rules.heading_close = () => '</strong></p>\n';
  return md;
}

const md = newRenderer();

export function renderComment(
  body: string,
  { known = new Set(), you = new Set() }: { known?: ReadonlySet<string>; you?: ReadonlySet<string> } = {},
): string {
  const env: CommentEnv = { known, you };
  return md.render(body, env as unknown as Record<string, unknown>);
}
