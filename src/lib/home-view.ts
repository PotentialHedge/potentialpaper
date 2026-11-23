/** The home list's views: compact rows, or detailed cards with each paper's cover and TL;DR or abstract. */
export type HomeView = 'compact' | 'detailed';

/** Where the reader's choice of view is kept, so the list opens in it next time. */
export const HOME_VIEW_COOKIE = 'home_view';

/** The view to show: the address's `view` (or `abstracts=1`, its old name) if it says one, else the kept choice. */
export function homeView(param: string | undefined, abstracts: string | undefined, kept: string | undefined): HomeView {
  if (param === 'detailed' || param === 'compact') return param;
  if (abstracts === '1') return 'detailed';
  return kept === 'detailed' ? 'detailed' : 'compact';
}
