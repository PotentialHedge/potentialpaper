'use client';

import { track } from '@/lib/track';
import { pluginPrompt } from '@/lib/agent-prompt';
import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { CopyField } from '@/components/CopyField';
import { ui } from '@/components/ui';
import {
  addDevPlugin,
  type DiscoveredPlugin,
  type Discovery,
  fetchDiscovered,
  fetchUpdates,
  installPlugin,
  type PluginUpdate,
  removeDevPlugin,
  setPluginEnabled,
  uninstallPlugin,
  usePlugins,
} from '@/lib/plugins/client';
import type { InstalledPlugin } from '@/lib/plugins/installed';
import { parsePluginSource, sourceKey } from '@/lib/plugins/sources';
import { pluginSettingsPath } from '@/lib/settings/form';
import { useSettings } from '@/lib/settings/client';
import { ApproveDialog } from './ApproveDialog';
import { PluginStatus } from './PluginDetail';

type Note = { ok: boolean; text: string } | null;

/** After an install: what to call it, and whether it waits to be approved. */
type OnInstalled = (installed: InstalledPlugin) => void;

function nameOf(p: InstalledPlugin): string {
  return `${p.plugin?.manifest.name ?? p.source}${p.ref ? ` ${p.ref}` : ''}`;
}

/** The site's origin, in the browser only (the page is the same HTML everywhere). */
function useOrigin(): string {
  return useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => '',
  );
}

/** The plugins page: what is installed (each linking to its own page), Discover, add by source, load from localhost. */
export function PluginsSettings() {
  const settings = useSettings();
  const { plugins, loaded } = usePlugins(null);
  const [updates, setUpdates] = useState<PluginUpdate[]>([]);
  const [note, setNote] = useState<Note>(null);
  const [approving, setApproving] = useState<InstalledPlugin | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const origin = useOrigin();
  const signedIn = settings.loaded && settings.signedIn;

  // Check again whenever the installed list changes: after an install, an update or a removal.
  const installedKey = plugins.map((p) => `${p.source}@${p.plugin?.commit ?? ''}`).join(' ');
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    fetchUpdates().then(
      (list) => !cancelled && setUpdates(list),
      () => !cancelled && setUpdates([]),
    );
    return () => {
      cancelled = true;
    };
  }, [signedIn, installedKey]);

  const installed = useMemo(() => new Set(plugins.map((p) => p.source)), [plugins]);

  /** Uninstall one, or stop loading it from the dev server. The site's own are turned off on their page instead. */
  async function remove(p: InstalledPlugin) {
    const name = p.plugin?.manifest.name ?? p.source;
    setNote(null);
    if (p.from === 'dev') {
      removeDevPlugin(p.source);
      setNote({ ok: true, text: `Removed ${name}.` });
      return;
    }
    setRemoving(p.source);
    try {
      await uninstallPlugin(p.source);
      setNote({ ok: true, text: `Removed ${name}.` });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setRemoving(null);
    }
  }

  /** Turn one of the site's plugins off or back on, for the reader. */
  async function toggle(p: InstalledPlugin) {
    setNote(null);
    setRemoving(p.source);
    try {
      await setPluginEnabled(p, !p.enabled);
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setRemoving(null);
    }
  }

  const onInstalled: OnInstalled = (p) => {
    if (p.status === 'consent' && p.plugin?.commit) setApproving(p);
    else setNote({ ok: true, text: `Installed ${nameOf(p)}.` });
  };

  return (
    <>
      <h2 className="font-serif text-xl font-normal">Plugins</h2>
      <p className="mt-1 mb-6 text-subtle">Plugins add panels to pages. Each runs once you approve what it asks for.</p>

      <section className="mb-8">
        <h3 className="mb-2 font-serif text-lg font-normal">Build one with your agent</h3>
        <CopyField
          value={pluginPrompt(origin || '')}
          label="Prompt for your AI agent"
          marker="prompt"
          onCopied={() => track('agent_prompt_copied', { target: 'plugins' })}
        />
      </section>
      {note && <p className={`${ui.note(note.ok)} mb-3 whitespace-pre-line`}>{note.text}</p>}

      <section className="mb-8">
        <h3 className="mb-2 font-serif text-lg font-normal">Installed</h3>
        {!loaded ? (
          <p className={ui.empty}>Loading your plugins…</p>
        ) : plugins.length === 0 ? (
          <p className={ui.fine}>No plugins installed. Find one below, or add one by its source.</p>
        ) : (
          <ul className="divide-y divide-rule-soft border border-rule bg-card">
            {plugins.map((p) => {
              const manifest = p.plugin?.manifest;
              const update = updates.find((u) => u.source === p.source);
              const settingsCount = manifest ? Object.keys(manifest.contributes.settings).length : 0;
              return (
                <li key={p.source} className="px-3 py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    {p.plugin ? (
                      <Link href={pluginSettingsPath(p.plugin.id)} className="font-semibold">
                        {manifest!.name}
                      </Link>
                    ) : (
                      <span className="font-semibold">{nameOf(p)}</span>
                    )}
                    {manifest && <span className="text-muted">{manifest.version}</span>}
                    {update && <span className="text-xs text-accent">{update.latest.version} is out</span>}
                    <span className="flex-1" />
                    <PluginStatus status={p.status} />
                    {(p.from === 'dev' || (signedIn && p.from === 'user')) && (
                      <button
                        type="button"
                        className={`${ui.linkBtn} text-sm`}
                        disabled={removing === p.source}
                        onClick={() => remove(p)}
                        aria-label={`Remove ${manifest?.name ?? p.source}`}
                      >
                        {removing === p.source ? 'Removing…' : 'remove'}
                      </button>
                    )}
                    {/* The site's own, when it didn't load: no page to turn it off on, so here. */}
                    {signedIn && p.from === 'site' && !p.plugin && (
                      <button
                        type="button"
                        className={`${ui.linkBtn} text-sm`}
                        disabled={removing === p.source}
                        onClick={() => toggle(p)}
                      >
                        {p.enabled ? 'turn off' : 'turn on'}
                      </button>
                    )}
                  </div>
                  {manifest?.description && <p className="mt-0.5 text-subtle">{manifest.description}</p>}
                  {p.error && <p className="mt-1 text-xs whitespace-pre-line text-down">{p.error}</p>}
                  {p.plugin && (
                    <p className={`${ui.fine} mt-1`}>
                      {p.plugin.id}
                      {settingsCount > 0 && ` · ${settingsCount} setting${settingsCount === 1 ? '' : 's'}`}
                      {p.from === 'site' && ' · installed by the site'}
                      {p.from === 'dev' && ' · from your dev server'}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {settings.loaded && !signedIn && (
          <p className={ui.fine}>
            <Link
              href="/signin?next=/settings/plugins"
              onClick={() => track('signin_prompt_clicked', { target: 'plugins' })}
            >
              Sign in
            </Link>{' '}
            to install plugins, or to turn the site&apos;s off.
          </p>
        )}
      </section>

      {signedIn && <AddBySource onNote={setNote} onInstalled={onInstalled} />}

      <Discover installed={installed} signedIn={signedIn} onNote={setNote} onInstalled={onInstalled} />

      <DevLoad onNote={setNote} />

      {approving && (
        <ApproveDialog
          installed={approving}
          onDone={(approved) => {
            setNote({
              ok: true,
              text: approved
                ? `Installed and approved ${nameOf(approving)}.`
                : `Installed ${nameOf(approving)}. Approve it on its page when you're ready.`,
            });
            setApproving(null);
          }}
        />
      )}
    </>
  );
}

/** Install a plugin by its source: a GitHub link, `owner/repo`, or `github:owner/repo/folder@tag`. */
function AddBySource({ onNote, onInstalled }: { onNote: (n: Note) => void; onInstalled: OnInstalled }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);

  async function install(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onNote(null);
    try {
      onInstalled(await installPlugin(source));
      setSource('');
    } catch (err) {
      onNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mb-8">
      <h3 className="mb-2 font-serif text-lg font-normal">Add by source</h3>
      <form onSubmit={install} className="flex gap-2">
        <input
          className={ui.input}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="https://github.com/owner/repo, owner/repo, or github:owner/repo/folder@v1.0.0"
          aria-label="A plugin's GitHub source"
        />
        <button type="submit" className={`${ui.linkBtn} mb-2`} disabled={busy || !source.trim()}>
          {busy ? 'Installing…' : 'Install'}
        </button>
      </form>
      <p className={`${ui.fine} mt-0`}>
        Without a tag, its newest release is installed (or its default branch, if it has none).
      </p>
    </section>
  );
}

const dateFormat = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' });

/** Public repos with the topic `potentialpaper-plugin`, most starred first. */
function Discover({
  installed,
  signedIn,
  onNote,
  onInstalled,
}: {
  installed: Set<string>;
  signedIn: boolean;
  onNote: (n: Note) => void;
  onInstalled: OnInstalled;
}) {
  const [state, setState] = useState<Discovery>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchDiscovered().then(
      ({ plugins, stale }) => !cancelled && setState({ status: 'ready', plugins, stale }),
      (err: Error) => !cancelled && setState({ status: 'error', error: err.message }),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function install(p: DiscoveredPlugin) {
    setBusy(p.source);
    onNote(null);
    try {
      onInstalled(await installPlugin(p.source));
    } catch (err) {
      onNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-8">
      <h3 className="mb-2 font-serif text-lg font-normal">Discover</h3>
      <p className={`${ui.fine} mt-0 mb-2`}>
        Public repos tagged{' '}
        <a href="https://github.com/topics/potentialpaper-plugin" rel="noopener noreferrer" target="_blank">
          potentialpaper-plugin
        </a>
        .
      </p>
      {state.status === 'loading' && <p className={ui.empty}>Asking GitHub…</p>}
      {state.status === 'error' && <p className={ui.note(false)}>{state.error}</p>}
      {state.status === 'ready' && (
        <>
          {state.stale && <p className={ui.fine}>GitHub can&apos;t be asked just now; this list is a little old.</p>}
          {state.plugins.length === 0 ? (
            <p className={ui.fine}>No plugins published yet.</p>
          ) : (
            <div className={ui.tableScroll}>
              <table className={`${ui.table} mt-0`}>
                <thead>
                  <tr>
                    <th className={ui.th()}>Plugin</th>
                    <th className={ui.th(true)}>Stars</th>
                    <th className={ui.th(true)}>Updated</th>
                    <th className={ui.th()} />
                  </tr>
                </thead>
                <tbody>
                  {state.plugins.map((p) => {
                    const key = sourceKey(parsePluginSource(p.source)!);
                    return (
                      <tr key={p.source} className="align-baseline">
                        <td className={ui.td}>
                          <a href={p.htmlUrl} rel="noopener noreferrer" target="_blank" className="font-semibold">
                            {p.owner}/{p.repo}
                          </a>
                          {p.description && <p className="mt-0.5 text-subtle">{p.description}</p>}
                        </td>
                        <td className={`${ui.td} ${ui.num}`}>{p.stars}</td>
                        <td className={`${ui.td} text-right whitespace-nowrap text-muted`}>
                          {p.pushedAt ? dateFormat.format(new Date(p.pushedAt)) : '–'}
                        </td>
                        <td className={`${ui.td} pl-4 text-right whitespace-nowrap`}>
                          {installed.has(key) ? (
                            <span className="text-muted">Installed</span>
                          ) : signedIn ? (
                            <button
                              className={ui.btn({ ghost: true, inline: true, flush: true })}
                              disabled={busy !== null}
                              onClick={() => install(p)}
                            >
                              {busy === p.source ? 'Installing…' : 'Install'}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Load a plugin from a dev server on this machine, in this browser only, for working on one. */
function DevLoad({ onNote }: { onNote: (n: Note) => void }) {
  const [devUrl, setDevUrl] = useState('');

  function load(e: FormEvent) {
    e.preventDefault();
    onNote(null);
    try {
      addDevPlugin(devUrl);
      setDevUrl('');
    } catch (err) {
      onNote({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <section>
      <h3 className="mb-2 font-serif text-lg font-normal">Load from localhost</h3>
      <p className={`${ui.fine} mt-0 mb-2`}>
        Runs in this browser only. Serve the folder with CORS on:{' '}
        <code className="font-mono">npx http-server . -p 5174 --cors</code>
      </p>
      <form onSubmit={load} className="flex gap-2">
        <input
          className={ui.input}
          value={devUrl}
          onChange={(e) => setDevUrl(e.target.value)}
          placeholder="http://localhost:5174/"
          aria-label="Your dev server's address"
        />
        <button type="submit" className={`${ui.linkBtn} mb-2`} disabled={!devUrl.trim()}>
          Load
        </button>
      </form>
    </section>
  );
}
