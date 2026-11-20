'use client';

import { createContext, type ReactNode, useContext } from 'react';
import type { PageKind } from '@/lib/kinds';
import type { AuthorPanel } from '@/lib/plugins/author-plugins';
import type { PageSummary } from '@/lib/plugins/protocol';

/**
 * What the page tells its plugins, given once by the page's server render (the same for every reader) and read by
 * every slot's plugin panels (`usePluginPanels`): the page, its scopes, and the facts its kind's `when` conditions
 * test. What depends on the reader (signed in, owner) comes with the plugin list, in the browser.
 */
export interface PluginPageData {
  kind: PageKind;
  page: PageSummary;
  scopes: PageSummary[];
  facts: { hasScores: boolean; hasSubmissions: boolean; hasSignals: boolean };
  /** A paper's `owners/plugins.json`: the panels its authors let into the author section. */
  authorPanels?: AuthorPanel[];
}

const PluginPageContext = createContext<PluginPageData | null>(null);

export function PluginPageProvider({ data, children }: { data: PluginPageData; children: ReactNode }) {
  return <PluginPageContext.Provider value={data}>{children}</PluginPageContext.Provider>;
}

export function usePluginPage(): PluginPageData | null {
  return useContext(PluginPageContext);
}
