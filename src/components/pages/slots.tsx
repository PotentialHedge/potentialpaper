import type { ComponentType, ReactNode } from 'react';
import { ArrangedPanels } from '@/components/ArrangedPanels';
import { ArrangedTabs } from '@/components/ArrangedTabs';
import { ui } from '@/components/ui';
import { type KeyedKind, KINDS, pagePath } from '@/lib/kinds';
import { slotPanels } from '@/lib/panels';
import type { PageLink } from '@/server/page-links';
import type { OrgOverview } from '@/server/org-pages';
import type { ScopePaper } from '@/server/page-members';
import type { UserPageView } from '@/server/user-pages';
import { LinksBox } from './LinkLists';
import { OrgAbout, OrgDepartments, OrgPeople, OrgTopics, OrgVenues } from './org-panels';
import {
  TopicAbout,
  TopicArticle,
  TopicIntroduced,
  TopicNeighbours,
  TopicOrgs,
  TopicPapers,
  TopicVenues,
  TopicSuggested,
  type TopicView,
} from './topic-panels';
import { UserActivity, UserComments, UserIdentity, UserPapers } from './user-panels';
import { VenueAbout, VenueEditions, VenueOrganizers, VenuePapers, VenueScores } from './venue-panels';

/**
 * The panels of the kinds of page other than a paper (`lib/kinds.ts`), by id in `lib/panels.ts`, rendered into a
 * kind's slots: `<kind>.main` beside `<kind>.aside`, then `<kind>.tabs`. A paper's are `components/paper/slots.tsx`.
 * What each kind shows beyond these generic panels comes with its phase of `handoffs/pages.md`: a venue's are in
 * `venue-panels.tsx`, an org's in `org-panels.tsx`. As on a paper, panels are the same HTML for every reader.
 */

export interface KindPanelProps {
  kind: KeyedKind;
  /** The page's key (`iclr/2027`); not `key`, which React keeps to itself. */
  pageKey: string;
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
  /** A person's page: what its account shows (`server/user-pages.ts`); `null` on other kinds. */
  user: UserPageView | null;
  /** An org's page: where it sits, its people, venues and topics (`server/org-pages.ts`); `null` on other kinds. */
  org: OrgOverview | null;
  /** A topic's page: its neighbours, papers and suggestions (`server/topic-pages.ts`); `null` on other kinds. */
  topic: TopicView | null;
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
        empty={kind === 'user' ? null : <p className={ui.empty}>Nobody has written anything here yet.</p>}
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

/** What the kind file says, in a line: a venue's is `VenueAbout`, an org's `OrgAbout`, a topic's `TopicAbout`. */
function About() {
  return null;
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

/**
 * A person's page (`user-panels.tsx`): `about` is its owners' part, the person's own words; the rest is what the
 * account chose to show.
 */
const USER_PANELS: Record<string, ComponentType<KindPanelProps>> = {
  ...PANELS,
  identity: UserIdentity,
  about: OwnersSection,
  papers: UserPapers,
  activity: UserActivity,
  comments: UserComments,
};

/**
 * Panels that are there only when what they show is: a person's tabs for items the account doesn't show would be
 * empty tabs, so they are left out of the slot altogether.
 */
const PRESENT: Partial<Record<KeyedKind, Record<string, (props: KindPanelProps) => boolean>>> = {
  user: {
    papers: ({ user }) => user?.claimedPapers != null,
    activity: ({ user }) => user?.activity != null,
    comments: ({ user }) => user?.comments != null,
  },
};

/**
 * A venue's own panels (`venue-panels.tsx`): its editions, its organisers' claim, its review scores, its submissions by
 * status.
 */
const VENUE_PANELS: Record<string, ComponentType<KindPanelProps>> = {
  ...PANELS,
  about: VenueAbout,
  editions: VenueEditions,
  organizers: VenueOrganizers,
  scores: VenueScores,
  papers: VenuePapers,
};

/**
 * An org's own panels (`org-panels.tsx`): where it sits, its departments and labs, the people who show it as their
 * institution, and its venues and topics by count. Its papers are the generic list, rolled up from its departments.
 */
const ORG_PANELS: Record<string, ComponentType<KindPanelProps>> = {
  ...PANELS,
  about: OrgAbout,
  departments: OrgDepartments,
  people: OrgPeople,
  venues: OrgVenues,
  topics: OrgTopics,
};

/**
 * A topic's own panels (`topic-panels.tsx`): its names and where it is edited, the article, the papers that introduced
 * it, its neighbouring topics, venues and organisations, its papers (sortable) and what might belong here.
 */
const TOPIC_PANELS: Record<string, ComponentType<KindPanelProps>> = {
  ...PANELS,
  about: TopicAbout,
  community: TopicArticle,
  introduced: TopicIntroduced,
  topics: TopicNeighbours,
  venues: TopicVenues,
  orgs: TopicOrgs,
  papers: TopicPapers,
  suggestions: TopicSuggested,
};

const KIND_PANELS: Partial<Record<KeyedKind, Record<string, ComponentType<KindPanelProps>>>> = {
  user: USER_PANELS,
  venue: VENUE_PANELS,
  org: ORG_PANELS,
  topic: TOPIC_PANELS,
};

/** A slot's panels, which the reader's settings may hide or reorder (`ArrangedPanels`, `ArrangedTabs`). */
export function KindSlot({ slot, ...props }: KindPanelProps & { slot: 'main' | 'aside' | 'tabs' }) {
  const panels = slotPanels(props.kind, `${props.kind}.${slot}`)
    .filter(({ id }) => PRESENT[props.kind]?.[id]?.(props) ?? true)
    .map(({ id, title }) => {
      const Panel = (KIND_PANELS[props.kind] ?? PANELS)[id];
      return { id, title, node: <Panel {...props} /> };
    });
  const name = `${props.kind}.${slot}`;
  if (slot === 'tabs') return <ArrangedTabs kind={props.kind} slot={name} panels={panels} />;
  return <ArrangedPanels kind={props.kind} slot={name} panels={panels} />;
}
