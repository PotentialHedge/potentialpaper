'use client';

import { Fragment, type ReactNode } from 'react';
import { usePluginPanels } from '@/components/plugins/PluginPanel';
import { arrangePanels, type PanelKind } from '@/lib/panels';
import { useSetting } from '@/lib/settings/client';

/**
 * A slot's built-in panels as the reader's settings arrange them (`<kind>.panels.hidden` and `.order`,
 * DESIGN.md §4.8). The panels are rendered on the server, the same for every reader; only which of them show, and
 * in what order, is decided here, after load, so the cached page stays one page. The reader's plugins' panels for
 * the slot join them here too (`usePluginPanels`), after the built-in ones unless `order` says otherwise.
 */
export function ArrangedPanels({
  kind,
  slot,
  panels,
}: {
  kind: PanelKind;
  /** The slot's full name (`venue.aside`), for plugins' panels; without it, built-in panels only. */
  slot?: string;
  panels: { id: string; node: ReactNode }[];
}) {
  const hidden = useSetting<string[]>(`${kind}.panels.hidden`);
  const order = useSetting<string[]>(`${kind}.panels.order`);
  const all = [...panels, ...usePluginPanels(slot)];
  const byId = new Map(all.map((p) => [p.id, p.node]));
  return arrangePanels(
    all.map((p) => p.id),
    hidden,
    order,
  ).map((id) => <Fragment key={id}>{byId.get(id)}</Fragment>);
}
