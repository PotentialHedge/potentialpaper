'use client';

import { type ReactNode, useState } from 'react';
import { AnalyticsPanel, usePageAnalytics } from '@/components/pages/Analytics';
import { usePluginPanels } from '@/components/plugins/PluginPanel';
import { ui } from '@/components/ui';
import { arrangePanels, type PanelKind } from '@/lib/panels';
import { useSetting } from '@/lib/settings/client';

/**
 * A `<kind>.tabs` slot: its panels as the reader's settings arrange them (as `ArrangedPanels`), shown one at a
 * time under a row of tabs, or alone when there is one. Panels are rendered on the server, the same for every
 * reader; only which one shows is decided here.
 *
 * With `lead`, that comes first as a tab of its own, which settings don't move or hide (a paper page's "Paper": the
 * page itself, which a plugin's tab is shown in place of). It stays mounted while another tab shows.
 */
export function ArrangedTabs({
  kind,
  slot,
  panels: builtIn,
  lead,
  pageId,
}: {
  kind: PanelKind;
  /** The slot's full name (`venue.tabs`), for plugins' panels, which join as tabs of their own. */
  slot?: string;
  panels: { id: string; title: string; node: ReactNode }[];
  lead?: { title: string; node: ReactNode };
  pageId?: string;
}) {
  const analytics = usePageAnalytics(pageId);
  const hidden = useSetting<string[]>(`${kind}.panels.hidden`);
  const order = useSetting<string[]>(`${kind}.panels.order`);
  const panels = [...builtIn, ...usePluginPanels(slot)];
  const ids = arrangePanels(
    panels.map((p) => p.id),
    hidden,
    order,
  );
  const ANALYTICS = '\0analytics';
  if (analytics) {
    panels.push({ id: ANALYTICS, title: 'Analytics', node: <AnalyticsPanel data={analytics} kind={kind} /> });
    ids.push(ANALYTICS);
  }
  const [chosen, setChosen] = useState<string | null>(null);
  const LEAD = '';
  const tabs = lead ? [LEAD, ...ids] : ids;
  const shown = tabs.includes(chosen ?? '\0') ? chosen! : tabs[0];
  if (shown === undefined) return null;
  const byId = new Map(panels.map((p) => [p.id, p]));
  const title = (id: string) => (id === LEAD ? lead!.title : byId.get(id)!.title);
  return (
    <section className={lead ? 'mt-5' : 'mt-8'}>
      {tabs.length > 1 && (
        <div role="tablist" className="mb-3 flex gap-4 border-b border-rule font-sans text-sm">
          {tabs.map((id) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={id === shown}
              onClick={() => setChosen(id)}
              className={`-mb-px cursor-pointer border-b-2 pb-1 ${id === shown ? `border-ink ${ui.on}` : 'border-transparent text-muted'}`}
            >
              {title(id)}
            </button>
          ))}
        </div>
      )}
      {lead && (
        <div role={tabs.length > 1 ? 'tabpanel' : undefined} hidden={shown !== LEAD}>
          {lead.node}
        </div>
      )}
      {shown !== LEAD && <div role={tabs.length > 1 ? 'tabpanel' : undefined}>{byId.get(shown)!.node}</div>}
    </section>
  );
}
