import type { ComponentType } from 'react';
import { ui } from '@/components/ui';
import { type KeyedKind, pagePath } from '@/lib/kinds';
import type { OrgOverview } from '@/server/org-pages';
import type { ScopePaper } from '@/server/page-members';
import type { UserPageView } from '@/server/user-pages';
import { Backlinks, Links, type PageCommon, Sections, Categories } from './common';
import { OrgAbout, OrgDepartments, OrgPeople, OrgVenues } from './org-panels';
import { CategoryAbout, CategoryMembers, type CategoryView } from './category-panels';
import { UserActivity, UserComments, UserIdentity, UserPapers } from './user-panels';
import { VenueAbout, VenueEditions, VenuePapers, VenueScores } from './venue-panels';

/**
 * The panels of the kinds of page other than a paper (`lib/kinds.ts`), by id in `lib/panels.ts`: every kind's
 * (`common.tsx`) and each kind's own (`venue-panels.tsx`, `org-panels.tsx`, `category-panels.tsx`, `user-panels.tsx`),
 * laid out by the page every kind shares (`PageView.tsx`). A paper's are `components/paper/slots.tsx`.
 */

export interface KindPanelProps extends PageCommon {
  kind: KeyedKind;
  /** The page's key (`iclr/2027`); not `key`, which React keeps to itself. */
  pageKey: string;
  /** Its kind file as it parses, or `null`. */
  kindFile: Record<string, unknown> | null;
  /** A scope's papers, rolled up from the pages under it, and how many there are; `null` on a page that isn't one. */
  papers: { count: number; list: ScopePaper[] } | null;
  /** A person's page: what its account shows (`server/user-pages.ts`); `null` on other kinds. */
  user: UserPageView | null;
  /** An org's page: where it sits, its people, venues and categories (`server/org-pages.ts`); `null` on other kinds. */
  org: OrgOverview | null;
  /** A category's page: its subcategories and other pages (`server/category-pages.ts`); `null` on other kinds. */
  category: CategoryView | null;
}

/** A scope's papers (`page_members`), rolled up: its departments' and labs'. */
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

const COMMON: Record<string, ComponentType<KindPanelProps>> = {
  sections: Sections,
  links: Links,
  backlinks: Backlinks,
  categories: Categories,
};

/** Each kind's panels by id: every kind's, and its own. */
export const KIND_PANELS: Record<KeyedKind, Record<string, ComponentType<KindPanelProps>>> = {
  // Its editions, its review scores, its submissions by status.
  venue: { ...COMMON, about: VenueAbout, editions: VenueEditions, scores: VenueScores, papers: VenuePapers },
  // Its article, then what is in it: its subcategories and its other pages, as a Wikipedia category lists them.
  category: { ...COMMON, about: CategoryAbout, members: CategoryMembers },
  // Where it sits, its departments and labs, the people who show it as their institution, its venues, and
  // its papers, rolled up from its departments.
  org: {
    ...COMMON,
    about: OrgAbout,
    departments: OrgDepartments,
    people: OrgPeople,
    venues: OrgVenues,
    papers: Papers,
  },
  // Only what the account chose to show (DESIGN.md §5.3), and its own words.
  user: { ...COMMON, identity: UserIdentity, papers: UserPapers, activity: UserActivity, comments: UserComments },
};

/**
 * Panels that are there only when what they show is: a person's tabs for items the account doesn't show would be
 * empty tabs, so they are left out of the slot altogether.
 */
export function presentPanel(props: KindPanelProps, id: string): boolean {
  if (props.kind !== 'user') return true;
  if (id === 'papers') return props.user?.claimedPapers != null;
  if (id === 'activity') return props.user?.activity != null;
  if (id === 'comments') return props.user?.comments != null;
  return true;
}
