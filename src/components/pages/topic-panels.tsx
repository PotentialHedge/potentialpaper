import type { ReactNode } from 'react';
import { TopicPapersList } from '@/components/topics/TopicPapersList';
import { TopicSuggestions } from '@/components/topics/TopicSuggestions';
import { ui } from '@/components/ui';
import { formatIdentifier, keyedPagePath } from '@/lib/kinds';
import { protectionWords } from '@/server/page-protection';
import type { PresentedTopicPapers } from '@/server/topic-papers';
import type { TopicNeighbour, TopicOverview } from '@/server/topic-pages';
import { CountBox } from './org-panels';
import type { KindPanelProps } from './slots';

/**
 * A topic's own panels (`handoffs/pages.md` Phase 5), beside the generic ones in `slots.tsx`. The page reads as an
 * article: what it is called and how to edit it, the community's article, the papers that introduced it; beside it
 * its broader, narrower and related topics, the venues where it is common and the organisations active in it; below,
 * its papers (rolled up, sortable) and what might belong here. What they show comes from `server/topic-pages.ts`'s
 * `topicOverview` and `topic-papers.ts`, read once by the route (`page-route.tsx`); like every panel, they are the
 * same HTML for every reader.
 */

export interface TopicView {
  overview: TopicOverview;
  /** The first page of its papers, newest first. */
  papers: PresentedTopicPapers;
}

/** Its other names, and whether it is protected. */
export function TopicAbout({ topic }: KindPanelProps) {
  if (!topic) return null;
  const { aliases, protection, mergedFrom } = topic.overview;
  const facts: ReactNode[] = [];
  if (aliases.length > 0) facts.push(<>Also called {aliases.join(', ')}</>);
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

/** The papers that introduced it, oldest first. */
export function TopicIntroduced({ topic }: KindPanelProps) {
  if (!topic || topic.overview.introducedBy.length === 0) return null;
  return (
    <section id="introduced">
      <h2 className={ui.groupHeading}>Where it started</h2>
      <ul className="space-y-1.5">
        {topic.overview.introducedBy.map((row) => (
          <li key={row.page.identifier}>
            <a href={row.page.address}>{row.page.name}</a>
            {row.year && <span className={ui.fine}> {row.year}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TopicList({ title, topics }: { title: string; topics: (TopicNeighbour & { missing?: boolean })[] }) {
  if (topics.length === 0) return null;
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-xs text-muted">{title}</div>
      <ul className="space-y-1">
        {topics.map((t) => (
          <li key={t.key} className="flex justify-between gap-2">
            {t.missing ? (
              <span className="text-muted italic">topic:{t.key}</span>
            ) : (
              <a href={keyedPagePath('topic', t.key)} className="text-ink">
                {t.name}
              </a>
            )}
            {!t.missing && <span className="text-xs text-muted tabular-nums">{t.papers.toLocaleString('en')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Its broader, narrower and related topics, each with its papers. */
export function TopicNeighbours({ topic }: KindPanelProps) {
  if (!topic) return null;
  const { broader, narrower, related } = topic.overview;
  if (broader.length + narrower.length + related.length === 0) return null;
  return (
    <div className={ui.box}>
      <h2 className={ui.boxHeading}>Topics</h2>
      <TopicList title="Broader" topics={broader} />
      <TopicList title="Narrower" topics={narrower} />
      <TopicList title="Related" topics={related} />
    </div>
  );
}

/** The venues where its papers are, by count. */
export function TopicVenues({ topic }: KindPanelProps) {
  return topic ? <CountBox title="Venues" kind="venue" pages={topic.overview.venues} /> : null;
}

/** The organisations its papers are from, by count. */
export function TopicOrgs({ topic }: KindPanelProps) {
  return topic ? <CountBox title="Organisations" kind="org" pages={topic.overview.orgs} /> : null;
}

/** Its papers, rolled up from narrower topics, sortable. */
export function TopicPapers({ topic, pageKey }: KindPanelProps) {
  if (!topic) return null;
  return <TopicPapersList identifier={formatIdentifier({ kind: 'topic', key: pageKey })} initial={topic.papers} />;
}

/** "Might belong here", with confirm and dismiss. */
export function TopicSuggested({ topic, pageKey }: KindPanelProps) {
  if (!topic) return null;
  const rows = topic.overview.suggestions.map((s) => ({
    identifier: s.page.identifier,
    url: s.page.url,
    title: s.page.name,
    year: s.year,
    reason: s.reason,
    matched: s.matched,
  }));
  return (
    <TopicSuggestions
      topic={formatIdentifier({ kind: 'topic', key: pageKey })}
      initial={rows}
      total={topic.overview.suggestionCount}
    />
  );
}
