import { renderMail, type RenderedMail } from './mail-html';

/**
 * The mails of claiming a paper (`server/claims.ts`, `server/claim-addresses.ts`): a code to an address printed on
 * it, a request to its confirmed co-authors, and the answer to the person who asked.
 */

function short(title: string): string {
  return title.length > 90 ? `${title.slice(0, 89).trimEnd()}…` : title;
}

/** A code to an address on the paper's first page, which the claimant types on the claim page. */
export function claimCodeMail(m: { code: string; title: string; authorName: string; claimUrl: string }): RenderedMail {
  return renderMail({
    siteUrl: new URL(m.claimUrl).origin,
    subject: `${m.code} is your PotentialPaper code for “${short(m.title)}”`,
    title: 'Confirm this address',
    byline: m.title,
    blocks: [
      {
        kind: 'p',
        text: `Someone is claiming to be ${m.authorName}, an author of this paper, and this address is on it.`,
      },
      { kind: 'code', label: 'Code', code: m.code, plain: `If that was you, the code is ${m.code}.` },
      { kind: 'link', label: 'Open the claim page', url: m.claimUrl },
      { kind: 'p', text: 'It works for an hour. If it was not you, ignore this; nothing changes without the code.' },
    ],
  });
}

/** To a confirmed author: someone asks to be confirmed as a co-author. */
export function claimRequestMail(m: {
  authorName: string;
  title: string;
  /** The claimant's confirmed addresses, which they agreed to show. */
  addresses: string[];
  note: string;
  papersUrl: string;
}): RenderedMail {
  const who = m.addresses.length > 0 ? ` (${m.addresses.join(', ')})` : '';
  return renderMail({
    siteUrl: new URL(m.papersUrl).origin,
    subject: `Is this ${m.authorName}? A claim on “${short(m.title)}”`,
    title: 'A co-author asks to be confirmed',
    byline: m.title,
    blocks: [
      {
        kind: 'p',
        text: `Someone${who} says they are ${m.authorName}, your co-author on this paper, and asks you to confirm it.`,
      },
      ...(m.note ? [{ kind: 'p' as const, text: `Their note: ${m.note}` }] : []),
      { kind: 'link', label: 'Confirm or deny on My papers', url: m.papersUrl },
      { kind: 'p', text: 'The first co-author to answer decides.' },
    ],
  });
}

/** To the claimant: a co-author said they are not that author. (A confirmation sends `renderCoAuthorMail`.) */
export function claimDeniedMail(m: { authorName: string; title: string; url: string }): RenderedMail {
  return renderMail({
    siteUrl: new URL(m.url).origin,
    subject: `Your claim on “${short(m.title)}” was not confirmed`,
    title: 'Claim not confirmed',
    byline: m.title,
    blocks: [
      {
        kind: 'p',
        text: `A co-author said you are not ${m.authorName}. If that is wrong, use "Report a problem" at the bottom of any page.`,
      },
      { kind: 'link', label: 'Open the paper', url: m.url },
    ],
  });
}
