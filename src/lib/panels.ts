/**
 * The built-in panels of each kind of page, by id, in their default order within their slot. Shared by the page
 * (`components/paper/slots.tsx` renders them) and by settings (`lib/settings/core.ts`), where a reader hides
 * (`<kind>.panels.hidden`) or reorders (`<kind>.panels.order`) them (DESIGN.md §4.8). Paper is the only kind so
 * far; the kinds of `handoffs/pages.md` add their entries here.
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
    { id: 'author', slot: 'paper.main', title: 'Author section' },
    { id: 'read', slot: 'paper.aside', title: 'Picture, PDF and links' },
    { id: 'versions-box', slot: 'paper.aside', title: 'Versions (side box)' },
    { id: 'submissions-box', slot: 'paper.aside', title: 'Submissions (side box)' },
    { id: 'community', slot: 'paper.body', title: 'Community section' },
    { id: 'versions', slot: 'paper.body', title: 'Versions' },
    { id: 'submissions', slot: 'paper.body', title: 'Submissions and reviews' },
    { id: 'discussion', slot: 'paper.body', title: 'Discussion' },
  ],
} as const satisfies Record<string, readonly PanelInfo[]>;

export type PanelKind = keyof typeof PAGE_PANELS;
export const PANEL_KINDS = Object.keys(PAGE_PANELS) as PanelKind[];

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
