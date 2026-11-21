import { ui } from '@/components/ui';
import { AbstractText } from '@/components/AbstractText';
import type { KindPanelProps } from './slots';

/**
 * A person's own panels (`handoffs/pages.md` Phase 3), beside the generic ones in `slots.tsx`: who they are, the papers
 * they authored, what they did and said under their handle. Each draws only what `userPageView`
 * (`server/user-pages.ts`) gives, which is only what the account chose to show (DESIGN.md §5.3): a panel whose item is
 * off draws nothing. Like every panel, the same HTML for every reader.
 */

const day = (at: Date) =>
  at.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The real name and institutions, under the handle, when the account shows them; then its bio, as an abstract. */
export function UserIdentity({ user }: KindPanelProps) {
  if (!user) return null;
  const parts = [user.realName, user.institutions?.join(', ')].filter((part): part is string => Boolean(part));
  if (user.bot) parts.push('A bot');
  if (parts.length === 0 && !user.bio) return null;
  return (
    <>
      {parts.length > 0 && <p className="text-center font-sans text-[15px] text-muted">{parts.join(' · ')}</p>}
      {user.bio && <AbstractText text={user.bio} className={parts.length > 0 ? 'mt-4' : ''} />}
    </>
  );
}

/** The papers the account is a confirmed author of, with the name it has on each. */
export function UserPapers({ user }: KindPanelProps) {
  if (!user?.claimedPapers) return null;
  return (
    <section id="papers">
      <h2 className={ui.groupHeading}>Papers</h2>
      {user.claimedPapers.length === 0 ? (
        <p className={ui.empty}>No confirmed papers yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {user.claimedPapers.map(({ page, year, authorName }) => (
            <li key={page.identifier}>
              <a href={page.address}>{page.name}</a>
              {year && <span className={ui.fine}> {year}</span>}
              <span className={ui.fine}> · as {authorName}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Edits and links under the handle, newest first. */
export function UserActivity({ user }: KindPanelProps) {
  if (!user?.activity) return null;
  if (user.activity.length === 0) return <p className={ui.empty}>Nothing yet.</p>;
  return (
    <ul className="space-y-1.5 font-sans text-sm">
      {user.activity.map((item, i) => (
        <li key={i}>
          <span className={ui.fine}>{day(item.at)} · </span>
          {item.kind === 'revert' ? 'Undid a change on ' : item.links ? 'Changed links on ' : 'Edited '}
          <a href={item.page.address}>{item.page.name}</a>
          <span className="text-subtle">: {item.summary}</span>
        </li>
      ))}
    </ul>
  );
}

/** Comments under the handle, newest first, each linked to its place in its thread. */
export function UserComments({ user }: KindPanelProps) {
  if (!user?.comments) return null;
  if (user.comments.length === 0) return <p className={ui.empty}>No comments yet.</p>;
  return (
    <ul className="space-y-3 font-sans text-sm">
      {user.comments.map((comment) => (
        <li key={comment.id}>
          <div className={ui.fine}>
            {day(comment.at)} · on <a href={`${comment.page.address}#comment-${comment.id}`}>{comment.page.name}</a>
          </div>
          <div className="text-ink">{comment.excerpt}</div>
        </li>
      ))}
    </ul>
  );
}
