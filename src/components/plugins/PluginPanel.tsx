'use client';

import Link from 'next/link';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { ui } from '@/components/ui';
import { grantPlugin, usePlugins } from '@/lib/plugins/client';
import type { Connection } from '@/lib/plugins/host';
import { useSetting } from '@/lib/settings/client';
import { pluginSettingsPath } from '@/lib/settings/form';
import {
  kindSlot,
  OWNERS_PLACES,
  type PanelContribution,
  panelPlace,
  PERMISSIONS,
  placeOfSlot,
  pluginPanelId,
  type PluginPermission,
} from '@/lib/plugins/manifest';
import { pageWhenContext, whenHolds } from '@/lib/plugins/when';
import { BotNote } from './BotNote';
import { PluginFrame, type ReadyPlugin } from './PluginFrame';
import { usePluginPage } from './PluginPage';

/**
 * Plugin panels in a page's slots (DESIGN.md §10): each installed plugin's panels for the page's kind and the slot,
 * whose `when` holds for this page and reader, beside the built-in ones (`ArrangedPanels`, `ArrangedTabs`), where
 * the reader's `<kind>.panels.hidden` and `.order` arrange them by `<plugin id>.<panel id>`, and `.placement` moves
 * them to another place. A plugin the reader hasn't approved shows its consent prompt in place of each panel, rather
 * than running. In the author section (`paper.author`) only the panels the paper's authors list show
 * (`owners/plugins.json`), each told what they set for it (`surface.config`).
 */

/**
 * A plugin's consent prompt: who made it, what it asks for in plain words, where it may send data, and whose data it
 * shows. `personal`: a running site default asking only for what the reader alone can give (`identity`), shown above
 * its frame.
 */
export function ConsentPrompt({
  plugin,
  signedIn,
  personal = false,
}: {
  plugin: ReadyPlugin;
  signedIn: boolean;
  personal?: boolean;
}) {
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
        {personal
          ? ', which this site runs for everyone, asks for more.'
          : isUpdate
            ? ', has been updated and asks for more.'
            : ', asks to run here.'}
      </p>
      {manifest.description && <p className={ui.fine}>{manifest.description}</p>}
      <p className="mt-2">It runs in a frame of its own and never sees your session. It may:</p>
      <ul className="mt-1 list-disc pl-5">
        {!personal && <li>Show panels on pages, and keep its own settings and a little data with your account</li>}
        {(personal ? plugin.missing.permissions : asks).map((p) => (
          <li key={p} className={plugin.missing.permissions.includes(p) ? '' : 'text-muted'}>
            {PERMISSIONS[p]}
          </li>
        ))}
        {!personal && manifest.network.length > 0 && (
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
        {!personal && <BotNote bot={plugin.plugin.bot} />}
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
  submission,
  config,
}: {
  plugin: ReadyPlugin;
  panel: PanelContribution;
  slot: string;
  viewer: { signedIn: boolean; isOwner: boolean };
  inTabs: boolean;
  submission?: PanelSubmission;
  /** In the author section: what the authors set for it. */
  config?: Record<string, unknown>;
}) {
  const page = usePluginPage();
  const connection = useRef<Connection | null>(null);
  const body =
    plugin.status === 'consent' ? (
      <ConsentPrompt plugin={plugin} signedIn={viewer.signedIn} />
    ) : (
      <>
        {viewer.signedIn && plugin.missing.permissions.length > 0 && (
          <ConsentPrompt plugin={plugin} signedIn personal />
        )}
        <PluginFrame
          plugin={plugin}
          surface={{
            type: 'panel',
            id: panel.id,
            slot,
            ...(submission && { submission: { venue: submission.venue } }),
            ...(config && { config }),
          }}
          page={page}
          viewer={viewer}
          title={`${panel.title} (${plugin.plugin.manifest.name})`}
          onConnect={(c) => {
            connection.current = c;
          }}
        />
      </>
    );
  const header = (
    <div className="mb-1 flex items-baseline justify-between gap-2 font-sans text-xs text-faint">
      <span>
        {!inTabs && <span className={`${ui.runIn} mr-2`}>{panel.title}</span>}
        <Link href={pluginSettingsPath(plugin.plugin.id)} className="text-faint">
          {plugin.plugin.manifest.name}
          {plugin.from === 'dev' ? ' (dev)' : ''}
        </Link>
      </span>
      {plugin.status === 'ready' && <CommandsMenu plugin={plugin} connection={connection} />}
    </div>
  );
  const aside = slot.endsWith('.aside');
  // Inside a built-in panel (under a submission, in the community or author section): closer to what is above it.
  const nested = ['submission', 'community', 'author'].includes(placeOfSlot(slot) ?? '');
  return (
    <section data-plugin={plugin.plugin.id} className={aside ? ui.box : nested ? 'mt-4' : 'mt-6'}>
      {header}
      {body}
    </section>
  );
}

/** The submission a `paper.submission` panel is drawn under: its venue, and whether it has scores (`page.hasScores`). */
export interface PanelSubmission {
  venue: { id: string; name: string };
  hasScores: boolean;
}

export interface SlotPanel {
  id: string;
  title: string;
  node: ReactNode;
}

/**
 * The plugin panels for a slot of the current page (`<kind>.main`, `.aside`, `.tabs`), in install order, as
 * `{ id, title, node }` for `ArrangedPanels` to arrange with the built-in ones. Empty off a page, and until the
 * plugin list arrives. In `paper.submission`, `submission` is the one they are drawn under, and `page.hasScores`
 * is whether it has scores.
 */
export function usePluginPanels(slot: string | undefined, submission?: PanelSubmission): SlotPanel[] {
  const page = usePluginPage();
  const { plugins, viewer } = usePlugins(page && slot ? page.page.identifier : null);
  const placement = useSetting<Record<string, string>>(`${page?.kind ?? 'paper'}.panels.placement`);
  return useMemo(() => {
    if (!page || !slot) return [];
    const facts = submission ? { ...page.facts, hasScores: submission.hasScores } : page.facts;
    const context = pageWhenContext(page.kind, { ...facts, ...viewer });
    const listed = new Map((page.authorPanels ?? []).map((p) => [p.panel, p]));
    const out: SlotPanel[] = [];
    for (const p of plugins) {
      if ((p.status !== 'ready' && p.status !== 'consent') || !p.plugin) continue;
      const ready = p as ReadyPlugin;
      for (const panel of ready.plugin.manifest.contributes.panels) {
        const id = pluginPanelId(ready.plugin.id, panel.id);
        const at = panelPlace(panel, page.kind, placement?.[id]);
        if (!at || kindSlot(page.kind, at) !== slot || !whenHolds(panel.when, context)) continue;
        // Only the page's owners let a panel into their section.
        const owners = OWNERS_PLACES.includes(at) ? listed.get(id) : undefined;
        if (OWNERS_PLACES.includes(at) && !owners) continue;
        out.push({
          id,
          title: panel.title,
          node: (
            <PluginPanel
              key={`${ready.plugin.id}@${ready.plugin.commit}`}
              plugin={ready}
              panel={panel}
              slot={slot}
              viewer={viewer}
              inTabs={slot.endsWith('.tabs')}
              submission={submission}
              config={owners ? (owners.settings ?? {}) : undefined}
            />
          ),
        });
      }
    }
    return out;
  }, [page, slot, plugins, viewer, submission, placement]);
}
