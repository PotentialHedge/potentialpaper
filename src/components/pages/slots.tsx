import type { ComponentType, ReactNode } from 'react';
import { ArrangedPanels } from '@/components/ArrangedPanels';
import { ArrangedTabs } from '@/components/ArrangedTabs';
import { ui } from '@/components/ui';
import { type KeyedKind, KINDS, type OrgFile, pagePath, type VenueFile } from '@/lib/kinds';
import { slotPanels } from '@/lib/panels';
import type { PageLink } from '@/server/page-links';
import type { ScopePaper } from '@/server/page-members';
import { LinksBox } from './LinkLists';

/**
 * The panels of the kinds of page other than a paper (`lib/kinds.ts`), by id in `lib/panels.ts`, rendered into a
 * kind's slots: `<kind>.main` beside `<kind>.aside`, then `<kind>.tabs`. A paper's are `components/paper/slots.tsx`.
 * What each kind shows beyond these generic panels (a venue's editions and statistics, a topic's suggestions, …)
 * comes with its phase of `handoffs/pages.md`. As on a paper, panels are the same HTML for every reader.
 */

export interface KindPanelProps {
  kind: KeyedKind;
  key: string;
  pageId: string;
  name: string;
  /** Its kind file as it parses, or `null`. */
  kindFile: Record<string, unknown> | null;
  /** The owners' part and `community/`, as rendered at their last commit. */
  ownersHtml: string | null;
  communityHtml: string | null;
  linksFrom: PageLink[];
  linksTo: PageLink[];
  /** A scope's papers, rolled up from the pages under it, and how many there are; `null` on a page that isn't one. */
  papers: { count: number; list: ScopePaper[] } | null;
}

function Html({ html, empty }: { html: string | null; empty: ReactNode }) {
  return html ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} /> : empty;
}

function OwnersSection({ kind, ownersHtml }: KindPanelProps) {
  const owners = KINDS[kind].owners;
  if (!owners) return null;
  return (
    <section id={owners.dir}>
      {kind !== 'user' && <h2 className={ui.groupHeading}>{owners.title}</h2>}
      <Html
        html={ownersHtml}
        empty={
          kind === 'venue' ? (
            <p className={ui.empty}>Organise this venue? Claiming it comes with organiser claims.</p>
          ) : kind === 'user' ? null : (
            <p className={ui.empty}>Nobody has written anything here yet.</p>
          )
        }
      />
    </section>
  );
}

function CommunitySection({ kind, communityHtml }: KindPanelProps) {
  if (!KINDS[kind].community) return null;
  return (
    <section id="community">
      <h2 className={ui.groupHeading}>{kind === 'topic' ? 'Article' : 'Community section'}</h2>
      <Html html={communityHtml} empty={<p className={ui.empty}>Nobody has written anything here yet.</p>} />
    </section>
  );
}

/** What the kind file says, in a line or two: a venue's dates and site, an org's ROR id, a topic's other names. */
function About({ kind, kindFile }: KindPanelProps) {
  if (!kindFile) return null;
  const facts: ReactNode[] = [];
  if (kind === 'venue') {
    const venue = kindFile as VenueFile;
    const dates = [venue.dates?.start, venue.dates?.end].filter(Boolean).join(' to ');
    if (dates) facts.push(dates);
    if (venue.url) facts.push(<a href={venue.url}>{new URL(venue.url).host}</a>);
  }
  if (kind === 'topic') {
    const aliases = (kindFile.aliases as string[] | undefined) ?? [];
    if (aliases.length > 0) facts.push(`Also called ${aliases.join(', ')}`);
  }
  if (kind === 'org') {
    const org = kindFile as OrgFile;
    if (org.ror) facts.push(<a href={org.ror}>ROR</a>);
    if (org.domains?.length) facts.push(org.domains.join(', '));
  }
  if (facts.length === 0) return null;
  return (
    <p className={`${ui.fine} text-center`}>
      {facts.map((fact, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {fact}
        </span>
      ))}
    </p>
  );
}

function Links({ linksFrom }: KindPanelProps) {
  return <LinksBox links={linksFrom} direction="from" />;
}

function Backlinks({ linksTo }: KindPanelProps) {
  return <LinksBox links={linksTo} direction="to" />;
}

/** A scope's papers (`page_members`), rolled up: its editions', narrower topics', labs'. */
function Papers({ papers }: KindPanelProps) {
  if (!papers) return null;
  if (papers.count === 0) return <p className={ui.empty}>No papers here yet.</p>;
  return (
    <div>
      <p className={`${ui.fine} mb-2`}>
        {papers.count} paper{papers.count === 1 ? '' : 's'}
        {papers.list.length < papers.count ? `, the first ${papers.list.length} shown` : ''}
      </p>
      <ul className="space-y-1.5">
        {papers.list.map((paper) => (
          <li key={paper.paperId}>
            {paper.address ? <a href={pagePath(paper.address)}>{paper.title}</a> : paper.title}
            {paper.year && <span className={ui.fine}> {paper.year}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PANELS: Record<string, ComponentType<KindPanelProps>> = {
  about: About,
  organizers: OwnersSection,
  members: OwnersSection,
  community: CommunitySection,
  links: Links,
  backlinks: Backlinks,
  papers: Papers,
};

/** A user page's `about` is its owners' part: the person's own words. */
const USER_PANELS: Record<string, ComponentType<KindPanelProps>> = { ...PANELS, about: OwnersSection };

/** A slot's panels, which the reader's settings may hide or reorder (`ArrangedPanels`, `ArrangedTabs`). */
export function KindSlot({ slot, ...props }: KindPanelProps & { slot: 'main' | 'aside' | 'tabs' }) {
  const panels = slotPanels(props.kind, `${props.kind}.${slot}`).map(({ id, title }) => {
    const Panel = (props.kind === 'user' ? USER_PANELS : PANELS)[id];
    return { id, title, node: <Panel {...props} /> };
  });
  if (slot === 'tabs') return <ArrangedTabs kind={props.kind} panels={panels} />;
  return <ArrangedPanels kind={props.kind} panels={panels} />;
}
