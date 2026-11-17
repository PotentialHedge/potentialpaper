'use client';

import { type ReactNode, useState } from 'react';
import { usePluginPanels } from '@/components/plugins/PluginPanel';
import { ui } from '@/components/ui';
import { arrangePanels, type PanelKind } from '@/lib/panels';
import { useSetting } from '@/lib/settings/client';

/**
 * A `<kind>.tabs` slot: its panels as the reader's settings arrange them (as `ArrangedPanels`), shown one at a
 * time under a row of tabs, or alone when there is one. Panels are rendered on the server, the same for every
 * reader; only which one shows is decided here.
 */
export function ArrangedTabs({
  kind,
  slot,
  panels: builtIn,
}: {
  kind: PanelKind;
  /** The slot's full name (`venue.tabs`), for plugins' panels, which join as tabs of their own. */
  slot?: string;
  panels: { id: string; title: string; node: ReactNode }[];
}) {
  const hidden = useSetting<string[]>(`${kind}.panels.hidden`);
  const order = useSetting<string[]>(`${kind}.panels.order`);
  const panels = [...builtIn, ...usePluginPanels(slot)];
  const ids = arrangePanels(
    panels.map((p) => p.id),
    hidden,
    order,
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = ids.includes(chosen ?? '') ? chosen! : ids[0];
  if (!shown) return null;
  const byId = new Map(panels.map((p) => [p.id, p]));
  return (
    <section className="mt-8">
      {ids.length > 1 && (
        <div role="tablist" className="mb-3 flex gap-4 border-b border-rule font-sans text-sm">
          {ids.map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={id === shown}
              onClick={() => setChosen(id)}
              className={`-mb-px cursor-pointer border-b-2 pb-1 ${id === shown ? `border-ink ${ui.on}` : 'border-transparent text-muted'}`}
            >
              {byId.get(id)!.title}
            </button>
          ))}
        </div>
      )}
      <div role={ids.length > 1 ? 'tabpanel' : undefined}>{byId.get(shown)!.node}</div>
    </section>
  );
}
