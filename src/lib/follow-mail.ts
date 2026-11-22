import { MENTION_QUOTE_CHARS } from './mention-mail';
import { renderMail, type RenderedMail } from './mail-html';

/**
 * The mails a followed paper sends (`server/follows.ts`): its page was edited, or someone commented on it; and
 * the mail to an author a co-author added. Each says why it came and where to stop it.
 */

function short(title: string): string {
  return title.length > 90 ? `${title.slice(0, 89).trimEnd()}…` : title;
}

function quote(body: string): string {
  return body.length > MENTION_QUOTE_CHARS ? `${body.slice(0, MENTION_QUOTE_CHARS).trimEnd()}…` : body;
}

export interface FollowNotes {
  /** Absolute: My papers, where a paper is unfollowed. */
  papersUrl: string;
  /** Absolute: the profile, where these mails are turned off. */
  settingsUrl: string;
}

function followNotes(n: FollowNotes): string[] {
  return [
    'You get this because you follow this paper. Authors follow their own papers.',
    `To unfollow it, go to ${n.papersUrl}; to stop all of these emails, ${n.settingsUrl}`,
  ];
}

export interface EditMail extends FollowNotes {
  title: string;
  /** The (last) commit's summary. */
  summary: string;
  /** How many commits this mail stands for (a push can bring several). */
  commits: number;
  /** Absolute: the paper's page. */
  url: string;
  /** Absolute: the page's history. */
  historyUrl: string;
}

/** A followed paper's page changed. Who changed it is in the history, as the page shows them. */
export function renderEditMail(m: EditMail): RenderedMail {
  const lead = m.commits > 1 ? `The page was edited (${m.commits} commits). The latest:` : 'The page was edited:';
  return renderMail({
    siteUrl: new URL(m.url).origin,
    subject: `Edited: “${short(m.title)}”`,
    title: 'A paper you follow was edited',
    byline: m.title,
    blocks: [
      { kind: 'p', text: lead, plain: `${lead}\n\n  ${m.title}` },
      { kind: 'quote', text: m.summary || '(no summary)' },
      { kind: 'link', label: 'See the changes', url: m.historyUrl, plain: `See the changes: ${m.historyUrl}` },
    ],
    notes: [
      'At most one of these an hour per paper, so there may be more edits since; the history has them all.',
      ...followNotes(m),
    ],
  });
}

export interface CommentMail extends FollowNotes {
  /** The commenter as the page shows them: a handle (a bot's ends in `[bot]`), an alias, or an author's name. */
  from: string;
  title: string;
  /** As written: raw Markdown. */
  body: string;
  /** Absolute: where the discussion is read. */
  url: string;
}

/** Someone commented on a followed paper. Names them as the page does, and quotes the comment, cut. */
export function renderCommentMail(m: CommentMail): RenderedMail {
  const lead = `${m.from} commented on`;
  return renderMail({
    siteUrl: new URL(m.url).origin,
    subject: `${m.from} commented on “${short(m.title)}”`,
    title: 'New comment',
    byline: m.title,
    blocks: [
      { kind: 'p', text: `${lead} a paper you follow:`, plain: `${lead}\n\n  ${m.title}` },
      { kind: 'quote', text: quote(m.body) },
      { kind: 'link', label: 'Read and reply', url: m.url, plain: `Read and reply: ${m.url}` },
    ],
    notes: followNotes(m),
  });
}

export interface CoAuthorMail {
  /** Who added them: `@handle`. */
  by: string;
  title: string;
  /** Which printed author they were made. */
  authorName: string;
  /** Absolute: the paper's page. */
  url: string;
  /** Absolute: My papers, where they accept, decline or step down. */
  papersUrl: string;
  /** Invited by handle, so they accept on My papers; else they asked, and were confirmed. */
  invited?: boolean;
}

/** A confirmed author invited the recipient to be a co-author, or confirmed the claim they made (`addCoAuthor`). */
export function renderCoAuthorMail(m: CoAuthorMail): RenderedMail {
  if (m.invited) {
    const lead = `${m.by} invited you to be ${m.authorName}, an author of`;
    return renderMail({
      siteUrl: new URL(m.url).origin,
      subject: `${m.by} invited you as an author of “${short(m.title)}”`,
      title: 'You were invited as an author',
      byline: m.title,
      blocks: [
        { kind: 'p', text: `${lead} this paper:`, plain: `${lead}\n\n  ${m.title}` },
        { kind: 'p', text: 'Accept or decline on My papers. Nothing changes until you accept.' },
        { kind: 'link', label: 'Open My papers', url: m.papersUrl, plain: `Open My papers: ${m.papersUrl}` },
      ],
    });
  }
  const lead = `${m.by} added you as ${m.authorName}, an author of`;
  return renderMail({
    siteUrl: new URL(m.url).origin,
    subject: `You were added as an author of “${short(m.title)}”`,
    title: 'You were added as an author',
    byline: m.title,
    blocks: [
      { kind: 'p', text: `${lead} this paper:`, plain: `${lead}\n\n  ${m.title}` },
      {
        kind: 'p',
        text: 'As one of its confirmed authors you write its author section, choose its picture and links, and follow it, so you hear of edits and comments.',
      },
      { kind: 'link', label: 'Open the paper', url: m.url, plain: `Open the paper: ${m.url}` },
    ],
    notes: [`If you aren't this author, step down on My papers: ${m.papersUrl}`],
  });
}
