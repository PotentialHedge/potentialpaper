import type { ReactNode } from 'react';
import { ui } from '@/components/ui';
import { formatIdentifier, KINDS, pagePath } from '@/lib/kinds';
import type { PageLink } from '@/server/page-links';
import { protectionWords } from '@/server/page-protection';
import type { TopicOverview } from '@/server/topic-pages';
import type { KindPanelProps } from './slots';

/**
 * A topic's own panels (`handoffs/pages.md` Phase 5), beside the generic ones in `slots.tsx`. A topic works as a
 * Wikipedia category does: the community's article, then the lists made from what is in it, its subtopics and its
 * other pages, by name. What they show comes from `server/topic-pages.ts`'s `topicOverview`, read once by the route
 * (`page-route.tsx`); like every panel, they are the same HTML for every reader.
 */

export type TopicView = TopicOverview;

/** What was merged into it, and whether it is protected. */
export function TopicAbout({ topic }: KindPanelProps) {
  if (!topic) return null;
  const { protection, mergedFrom } = topic;
  const facts: ReactNode[] = [];
  if (mergedFrom.length > 0) {
    facts.push(<>Merged with {mergedFrom.map((key) => formatIdentifier({ kind: 'topic', key })).join(', ')}</>);
  }
  facts.push(<a href="/new/topic">New topic</a>);
  return (
    <div>
      <p className={`${ui.fine} text-center`}>
        {facts.map((fact, i) => (
          <span key={i}>
            {i > 0 && ' · '}
            {fact}
          </span>
        ))}
      </p>
      {protection && (
        <p className={`${ui.fine} text-center`}>
          Protected: {protectionWords(protection.level)}
          {protection.reason ? ` (${protection.reason})` : ''}.
        </p>
      )}
    </div>
  );
}

/** Most of a list shown; the API has the rest (`GET /pages/{identifier}/topic`). */
const SHOWN = 200;

function MemberList({ title, links }: { title: string; links: PageLink[] }) {
  if (links.length === 0) return null;
  return (
    <section>
      <h2 className={ui.groupHeading}>
        {title} <span className={ui.fine}>({links.length.toLocaleString('en')})</span>
      </h2>
      <ul className="columns-2 gap-8 narrow:columns-1">
        {links.slice(0, SHOWN).map((link) => (
          <li key={link.page.pageId} className="mb-1 break-inside-avoid">
            {link.page.address ? (
              <a href={pagePath(link.page.address)}>{link.page.name ?? formatIdentifier(link.page.address)}</a>
            ) : (
              link.page.name
            )}
            {link.page.kind !== 'paper' && link.page.kind !== 'topic' && link.page.kind !== 'web' && (
              <span className={ui.fine}> {KINDS[link.page.kind].title.toLowerCase()}</span>
            )}
          </li>
        ))}
      </ul>
      {links.length > SHOWN && <p className={ui.fine}>and {(links.length - SHOWN).toLocaleString('en')} more</p>}
    </section>
  );
}

/** What is in it, as a Wikipedia category lists it: its subtopics, then its other pages, each by name. */
export function TopicMembers({ topic }: KindPanelProps) {
  if (!topic) return null;
  if (topic.subtopics.length + topic.pages.length === 0) {
    return <p className={ui.empty}>Nothing is in this topic yet. Add a page to it from that page.</p>;
  }
  return (
    <>
      <MemberList title="Subtopics" links={topic.subtopics} />
      <MemberList title="Pages" links={topic.pages} />
    </>
  );
}
