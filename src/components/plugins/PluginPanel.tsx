'use client';

import { type ReactNode, useMemo, useRef, useState } from 'react';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { ui } from '@/components/ui';
import { grantPlugin, usePlugins } from '@/lib/plugins/client';
import type { Connection } from '@/lib/plugins/host';
import {
  kindSlot,
  type PanelContribution,
  panelSlot,
  PERMISSIONS,
  pluginPanelId,
  type PluginPermission,
} from '@/lib/plugins/manifest';
import { pageWhenContext, whenHolds } from '@/lib/plugins/when';
import { PluginFrame, type ReadyPlugin } from './PluginFrame';
import { usePluginPage } from './PluginPage';

/**
 * Plugin panels in a page's slots (DESIGN.md §10): each installed plugin's panels for the page's kind and the slot,
 * whose `when` holds for this page and reader, beside the built-in ones (`ArrangedPanels`, `ArrangedTabs`), where
 * the reader's `<kind>.panels.hidden` and `.order` arrange them by `<plugin id>.<panel id>`. A plugin the reader
 * hasn't approved shows its consent prompt in place of each panel, rather than running.
 */

/** A plugin's consent prompt: who made it, what it asks for in plain words, and where it may send data. */
export function ConsentPrompt({ plugin, signedIn }: { plugin: ReadyPlugin; signedIn: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  const { manifest, commit, sourceUrl, id } = plugin.plugin;
  const asks = manifest.permissions as PluginPermission[];
  const isUpdate =
    plugin.missing.permissions.length < asks.length || plugin.missing.network.length < manifest.network.length;
  async function allow() {
    if (!commit) return;
    setBusy(true);
    setError(null);
    try {
      await grantPlugin(id, commit);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className={ui.box} role="group" aria-label={`Approve the plugin ${manifest.name}`}>
      <p>
        <b>{manifest.name}</b> {manifest.version}, a plugin you installed from{' '}
        <a href={sourceUrl} rel="noopener noreferrer" target="_blank">
          {id}
        </a>
        {commit && <span className={ui.mono}> @{commit.slice(0, 7)}</span>}
        {isUpdate ? ', has been updated and asks for more.' : ', asks to run here.'}
      </p>
      {manifest.description && <p className={ui.fine}>{manifest.description}</p>}
      <p className="mt-2">It runs in a frame of its own and never sees your session. It may:</p>
      <ul className="mt-1 list-disc pl-5">
        <li>Show panels on pages, and keep its own settings and a little data with your account</li>
        {asks.map((p) => (
          <li key={p} className={plugin.missing.permissions.includes(p) ? '' : 'text-muted'}>
            {PERMISSIONS[p]}
          </li>
        ))}
        {manifest.network.length > 0 && (
          <li>
            Send data to and load data from{' '}
            {manifest.network.map((origin, i) => (
              <span key={origin}>
                {i > 0 && ', '}
                <span className={ui.mono}>{origin}</span>
              </span>
            ))}
          </li>
        )}
      </ul>
      {error && <p className="mt-2 text-accent">{error}</p>}
      <div className="mt-3 flex gap-3">
        {signedIn ? (
          <button type="button" className={ui.linkBtn} onClick={allow} disabled={busy}>
            {busy ? 'Allowing…' : 'Allow'}
          </button>
        ) : (
          <span className={ui.fine}>Sign in to approve it.</span>
        )}
        <button type="button" className={ui.linkBtn} onClick={() => setDismissed(true)}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** A panel's menu of its plugin's commands, each run in the panel's frame. */
function CommandsMenu({ plugin, connection }: { plugin: ReadyPlugin; connection: React.RefObject<Connection | null> }) {
  const commands = plugin.plugin.manifest.contributes.commands;
  const [note, setNote] = useState<string | null>(null);
  if (commands.length === 0) return null;
  async function run(command: string) {
    setNote(null);
    try {
      if (!connection.current) throw new Error("the plugin hasn't started yet");
      await connection.current.call('commands.run', { command });
    } catch (e) {
      setNote((e as Error).message);
    }
  }
  return (
    <span>
      {note && <span className="mr-2 text-accent">{note}</span>}
      <Popover>
        <PopoverTrigger className={`${ui.linkBtn} text-xs`} aria-label={`${plugin.plugin.manifest.name}: commands`}>
          ⋯
        </PopoverTrigger>
        <PopoverContent menu align="end">
          {commands.map((c) => (
            <PopoverClose asChild key={c.id}>
              <button type="button" className={`${ui.linkBtn} text-left`} onClick={() => run(c.id)}>
                {c.title}
              </button>
            </PopoverClose>
          ))}
        </PopoverContent>
      </Popover>
    </span>
  );
}

function PluginPanel({
  plugin,
  panel,
  slot,
  viewer,
  inTabs,
}: {
  plugin: ReadyPlugin;
  panel: PanelContribution;
  slot: string;
  viewer: { signedIn: boolean; isOwner: boolean };
  inTabs: boolean;
}) {
  const page = usePluginPage();
  const connection = useRef<Connection | null>(null);
  const body =
    plugin.status === 'consent' ? (
      <ConsentPrompt plugin={plugin} signedIn={viewer.signedIn} />
    ) : (
      <PluginFrame
        plugin={plugin}
        surface={{ type: 'panel', id: panel.id, slot }}
        page={page}
        viewer={viewer}
        title={`${panel.title} (${plugin.plugin.manifest.name})`}
        onConnect={(c) => {
          connection.current = c;
        }}
      />
    );
  const header = (
    <div className="mb-1 flex items-baseline justify-between gap-2 font-sans text-xs text-faint">
      <span>
        {!inTabs && <span className={`${ui.runIn} mr-2`}>{panel.title}</span>}
        <a href={plugin.plugin.sourceUrl} rel="noopener noreferrer" target="_blank" className="text-faint">
          {plugin.plugin.manifest.name}
          {plugin.from === 'dev' ? ' (dev)' : ''}
        </a>
      </span>
      {plugin.status === 'ready' && <CommandsMenu plugin={plugin} connection={connection} />}
    </div>
  );
  const aside = slot.endsWith('.aside');
  return (
    <section data-plugin={plugin.plugin.id} className={aside ? ui.box : 'mt-6'}>
      {header}
      {body}
    </section>
  );
}

export interface SlotPanel {
  id: string;
  title: string;
  node: ReactNode;
}

/**
 * The plugin panels for a slot of the current page (`<kind>.main`, `.aside`, `.tabs`), in install order, as
 * `{ id, title, node }` for `ArrangedPanels` to arrange with the built-in ones. Empty off a page, and until the
 * plugin list arrives.
 */
export function usePluginPanels(slot: string | undefined): SlotPanel[] {
  const page = usePluginPage();
  const { plugins, viewer } = usePlugins(page && slot ? page.page.identifier : null);
  return useMemo(() => {
    if (!page || !slot) return [];
    const context = pageWhenContext(page.kind, { ...page.facts, ...viewer });
    const out: SlotPanel[] = [];
    for (const p of plugins) {
      if ((p.status !== 'ready' && p.status !== 'consent') || !p.plugin) continue;
      const ready = p as ReadyPlugin;
      for (const panel of ready.plugin.manifest.contributes.panels) {
        const at = panelSlot(panel, page.kind);
        if (!at || kindSlot(page.kind, at) !== slot || !whenHolds(panel.when, context)) continue;
        out.push({
          id: pluginPanelId(ready.plugin.id, panel.id),
          title: panel.title,
          node: (
            <PluginPanel
              key={`${ready.plugin.id}@${ready.plugin.commit}`}
              plugin={ready}
              panel={panel}
              slot={slot}
              viewer={viewer}
              inTabs={slot.endsWith('.tabs')}
            />
          ),
        });
      }
    }
    return out;
  }, [page, slot, plugins, viewer]);
}
