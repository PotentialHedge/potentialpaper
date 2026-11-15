import { renderMail, type RenderedMail } from './mail-html';

/** How much of the comment a mention mail quotes. */
export const MENTION_QUOTE_CHARS = 800;

export interface MentionMail {
  /** The mentioner as the page shows them: a handle, an alias ("Anonymous k3xm"), or an author's name. */
  from: string;
  title: string;
  /** As written: raw Markdown. */
  body: string;
  /** Absolute: where the discussion is read. */
  url: string;
  /** Absolute: where the mail is turned off. */
  settingsUrl: string;
}

/** The mail a `@` mention sends. It names the mentioner as the page does, and quotes the comment as posted, cut. */
export function renderMentionMail(m: MentionMail): RenderedMail {
  const title = m.title.length > 90 ? `${m.title.slice(0, 89).trimEnd()}…` : m.title;
  const body = m.body.length > MENTION_QUOTE_CHARS ? `${m.body.slice(0, MENTION_QUOTE_CHARS).trimEnd()}…` : m.body;
  const lead = `${m.from} mentioned you in the discussion of`;
  return renderMail({
    siteUrl: new URL(m.url).origin,
    subject: `${m.from} mentioned you on “${title}”`,
    title: 'You were mentioned',
    byline: m.title,
    blocks: [
      { kind: 'p', text: `${lead} this paper:`, plain: `${lead}\n\n  ${m.title}` },
      { kind: 'quote', text: body },
      { kind: 'link', label: 'Read and reply', url: m.url, plain: `Read and reply: ${m.url}` },
    ],
    notes: [
      'You get this because someone mentioned your handle, or your alias on this paper, in a comment.',
      `To stop these emails, go to ${m.settingsUrl}`,
    ],
  });
}
