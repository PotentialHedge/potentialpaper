'use client';

import { Fragment, type ReactNode } from 'react';
import { arrangePanels, type PanelKind } from '@/lib/panels';
import { useSetting } from '@/lib/settings/client';

/**
 * A slot's built-in panels as the reader's settings arrange them (`<kind>.panels.hidden` and `.order`,
 * DESIGN.md §4.8). The panels are rendered on the server, the same for every reader; only which of them show, and
 * in what order, is decided here, after load, so the cached page stays one page.
 */
export function ArrangedPanels({ kind, panels }: { kind: PanelKind; panels: { id: string; node: ReactNode }[] }) {
  const hidden = useSetting<string[]>(`${kind}.panels.hidden`);
  const order = useSetting<string[]>(`${kind}.panels.order`);
  const byId = new Map(panels.map((p) => [p.id, p.node]));
  return arrangePanels(
    panels.map((p) => p.id),
    hidden,
    order,
  ).map((id) => <Fragment key={id}>{byId.get(id)}</Fragment>);
}
