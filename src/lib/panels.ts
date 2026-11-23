import { PAGE_KINDS } from './kinds';

/**
 * The built-in panels of each kind of page (`lib/kinds.ts`), by id, in their default order within their slot. Shared
 * by the pages (`components/paper/slots.tsx` and `components/pages/slots.tsx` render them) and by settings
 * (`lib/settings/core.ts`), where a reader hides (`<kind>.panels.hidden`) or reorders (`<kind>.panels.order`) them
 * (DESIGN.md §4.8). Every slot is one of its kind's (`KINDS[kind].slots`): `<kind>.main`, `<kind>.aside`,
 * `<kind>.body` and `<kind>.tabs` on every kind, which plugins' panels join too (`handoffs/plugins.md` Phase 2).
 *
 * **Ids are stable.** They are what people's settings name, so renaming one drops it from their files.
 */
export interface PanelInfo {
  id: string;
  slot: string;
  /** How the settings form names it. */
  title: string;
}

export const PAGE_PANELS = {
  paper: [
    { id: 'abstract', slot: 'paper.main', title: 'Abstract' },
    { id: 'sections', slot: 'paper.main', title: 'Sections' },
    { id: 'read', slot: 'paper.aside', title: 'Picture, PDF and links' },
    { id: 'facts', slot: 'paper.aside', title: 'Venues, location and keywords' },
    { id: 'versions-box', slot: 'paper.aside', title: 'Versions (infobox)' },
    { id: 'categories', slot: 'paper.aside', title: 'Categories' },
    { id: 'links', slot: 'paper.aside', title: 'Labeled links' },
    { id: 'backlinks', slot: 'paper.aside', title: 'What links here' },
    { id: 'versions', slot: 'paper.body', title: 'Versions' },
    { id: 'submissions', slot: 'paper.body', title: 'Submissions and reviews' },
    { id: 'discussion', slot: 'paper.body', title: 'Discussion' },
  ],
  venue: [
    { id: 'about', slot: 'venue.aside', title: 'Dates, location and website' },
    { id: 'editions', slot: 'venue.main', title: 'Editions' },
    { id: 'scores', slot: 'venue.main', title: 'Review scores' },
    { id: 'sections', slot: 'venue.main', title: 'Sections' },
    { id: 'categories', slot: 'venue.aside', title: 'Categories' },
    { id: 'links', slot: 'venue.aside', title: 'Labeled links' },
    { id: 'backlinks', slot: 'venue.aside', title: 'What links here' },
    { id: 'papers', slot: 'venue.tabs', title: 'Papers' },
  ],
  category: [
    { id: 'about', slot: 'category.main', title: 'About the category' },
    { id: 'sections', slot: 'category.main', title: 'Article' },
    { id: 'members', slot: 'category.main', title: 'Subcategories and pages' },
    { id: 'categories', slot: 'category.aside', title: 'Categories' },
    { id: 'links', slot: 'category.aside', title: 'Labeled links' },
    { id: 'backlinks', slot: 'category.aside', title: 'What links here' },
  ],
  org: [
    { id: 'about', slot: 'org.main', title: 'About the organisation' },
    { id: 'departments', slot: 'org.main', title: 'Departments and labs' },
    { id: 'sections', slot: 'org.main', title: 'Sections' },
    { id: 'people', slot: 'org.aside', title: 'People' },
    { id: 'venues', slot: 'org.aside', title: 'Venues' },
    { id: 'categories', slot: 'org.aside', title: 'Categories' },
    { id: 'links', slot: 'org.aside', title: 'Labeled links' },
    { id: 'backlinks', slot: 'org.aside', title: 'What links here' },
    { id: 'papers', slot: 'org.tabs', title: 'Papers' },
  ],
  user: [
    { id: 'identity', slot: 'user.main', title: 'Bio' },
    { id: 'papers', slot: 'user.main', title: 'Papers they authored' },
    { id: 'backlinks', slot: 'user.aside', title: 'What links here' },
    { id: 'activity', slot: 'user.tabs', title: 'Activity' },
    { id: 'comments', slot: 'user.tabs', title: 'Comments' },
  ],
} as const satisfies Record<string, readonly PanelInfo[]>;

/** How the settings form names each slot. */
export const SLOT_TITLES: Record<string, string> = Object.fromEntries([
  ...PAGE_KINDS.flatMap((kind) => [
    [`${kind}.main`, 'Main column'],
    [`${kind}.aside`, 'Side column'],
    [`${kind}.body`, 'Below both'],
    [`${kind}.tabs`, 'Tabs'],
  ]),
  ['paper.submission', 'Under each submission'],
  ['paper.community', "In the community's sections"],
  ['paper.author', "In the authors' sections"],
]);

/**
 * Slots drawn inside a built-in panel, by that panel: plugins' panels there are set under it in the settings form, as
 * sub-items with their own switches, in the parent's part of the page.
 */
export const SLOT_PARENTS: Record<string, { panel: string; slot: string }> = {
  'paper.submission': { panel: 'submissions', slot: 'paper.body' },
  'paper.community': { panel: 'sections', slot: 'paper.main' },
  'paper.author': { panel: 'sections', slot: 'paper.main' },
};

export type PanelKind = keyof typeof PAGE_PANELS;
export const PANEL_KINDS = Object.keys(PAGE_PANELS) as PanelKind[];

/** A slot's panels, in their default order. */
export function slotPanels<K extends PanelKind>(kind: K, slot: string): (typeof PAGE_PANELS)[K][number][] {
  return (PAGE_PANELS[kind] as readonly (typeof PAGE_PANELS)[K][number][]).filter((p) => p.slot === slot);
}

export type PanelId<K extends PanelKind = PanelKind> = (typeof PAGE_PANELS)[K][number]['id'];

export function panelIds(kind: PanelKind): string[] {
  return PAGE_PANELS[kind].map((p) => p.id);
}

/**
 * A slot's panel ids as a reader's settings arrange them: hidden ones left out, those named in `order` first, in
 * that order, and the rest after them in their default order.
 */
export function arrangePanels(ids: readonly string[], hidden: readonly string[], order: readonly string[]): string[] {
  const shown = ids.filter((id) => !hidden.includes(id));
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at === -1 ? order.length + ids.indexOf(id) : at;
  };
  return shown.toSorted((a, b) => rank(a) - rank(b));
}
