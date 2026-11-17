'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ui } from '@/components/ui';
import {
  addDevPlugin,
  type DiscoveredPlugin,
  type Discovery,
  fetchDiscovered,
  fetchUpdates,
  installPlugin,
  type PluginUpdate,
  usePlugins,
} from '@/lib/plugins/client';
import { parsePluginSource, sourceKey } from '@/lib/plugins/sources';
import { pluginSettingsPath } from '@/lib/settings/form';
import { useSettings } from '@/lib/settings/client';
import { STATUS, STATUS_COLOR } from './PluginDetail';

type Note = { ok: boolean; text: string } | null;

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

  return (
    <>
      <h2 className="font-serif text-xl font-normal">Plugins</h2>
      <p className="mt-1 mb-2 text-subtle">
        Plugins add panels to pages: a paper, a venue, a topic, an organisation or a person. Each comes from a public
        GitHub repo, pinned to a commit, and runs in a frame of its own that sees only what the site gives it. A plugin
        runs once you approve what it asks for. Each installed plugin has a page of its own here, with its settings.
      </p>
      <p className="mb-6 text-subtle">
        To build one, ask your agent:{' '}
        <q className="text-ink">Read {origin || 'this site'}/plugins.md and build me a PotentialPaper plugin.</q> The
        guide is at <a href="/plugins.md">/plugins.md</a>.
      </p>
      {note && <p className={`${ui.note(note.ok)} mb-3 whitespace-pre-line`}>{note.text}</p>}

      <section className="mb-8">
        <h3 className="mb-2 font-serif text-lg font-normal">Installed</h3>
        {!loaded ? (
          <p className={ui.empty}>Loading your plugins…</p>
        ) : plugins.length === 0 ? (
          <p className={ui.fine}>No plugins installed. Find one below, or add one by its source.</p>
        ) : (
          <ul className="max-w-[640px] divide-y divide-rule-soft border border-rule bg-card">
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
                      <span className="font-semibold">{p.source}</span>
                    )}
                    {manifest && <span className="text-muted">{manifest.version}</span>}
                    {update && <span className="text-xs text-accent">{update.latest.version} is out</span>}
                    <span className="flex-1" />
                    <span className={STATUS_COLOR[p.status]}>{STATUS[p.status]}</span>
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
            <Link href="/signin?next=/settings/plugins">Sign in</Link> to install plugins, or to turn the site&apos;s
            off.
          </p>
        )}
      </section>

      {signedIn && <AddBySource onNote={setNote} />}

      <Discover installed={installed} signedIn={signedIn} onNote={setNote} />

      <DevLoad onNote={setNote} />
    </>
  );
}

/** Install a plugin by its source: a GitHub link, `owner/repo`, or `github:owner/repo/folder@tag`. */
function AddBySource({ onNote }: { onNote: (n: Note) => void }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);

  async function install(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    onNote(null);
    try {
      const installed = await installPlugin(source);
      onNote({
        ok: true,
        text: `Installed ${installed.plugin?.manifest.name ?? installed.source}${installed.ref ? ` ${installed.ref}` : ''}. Approve it on its page, or on a page it shows on.`,
      });
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
}: {
  installed: Set<string>;
  signedIn: boolean;
  onNote: (n: Note) => void;
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
      const done = await installPlugin(p.source);
      onNote({
        ok: true,
        text: `Installed ${done.plugin?.manifest.name ?? p.repo}${done.ref ? ` ${done.ref}` : ''}. Approve it on its page, or on a page it shows on.`,
      });
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
        Public GitHub repos with the topic{' '}
        <a href="https://github.com/topics/potentialpaper-plugin" rel="noopener noreferrer" target="_blank">
          potentialpaper-plugin
        </a>
        , most starred first. Anyone can publish one; look at what it asks for before you approve it.
      </p>
      {state.status === 'loading' && <p className={ui.empty}>Asking GitHub…</p>}
      {state.status === 'error' && <p className={ui.note(false)}>{state.error}</p>}
      {state.status === 'ready' && (
        <>
          {state.stale && <p className={ui.fine}>GitHub can&apos;t be asked just now; this list is a little old.</p>}
          {state.plugins.length === 0 ? (
            <p className={ui.fine}>No plugins published yet.</p>
          ) : (
            <ul className="space-y-3">
              {state.plugins.map((p) => {
                const key = sourceKey(parsePluginSource(p.source)!);
                return (
                  <li key={p.source} className="flex items-baseline gap-3">
                    <div className="min-w-0 flex-1">
                      <a href={p.htmlUrl} rel="noopener noreferrer" target="_blank" className="font-semibold">
                        {p.owner}/{p.repo}
                      </a>
                      <span className="ml-2 text-muted tabular-nums" title={`${p.stars} stars`}>
                        ★ {p.stars}
                      </span>
                      {p.description && <p className="mt-0.5">{p.description}</p>}
                      {p.pushedAt && (
                        <p className={`${ui.fine} mt-0`}>last pushed {dateFormat.format(new Date(p.pushedAt))}</p>
                      )}
                    </div>
                    {installed.has(key) ? (
                      <span className="text-muted">Installed</span>
                    ) : signedIn ? (
                      <button className={ui.linkBtn} disabled={busy !== null} onClick={() => install(p)}>
                        {busy === p.source ? 'Installing…' : 'Install'}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
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
        For building a plugin: it runs in this browser only, unpinned, and needs no approval. Serve its folder with CORS
        on (<code className="font-mono">npx http-server . -p 5174 --cors</code>); see{' '}
        <a href="/plugins.md">the guide</a>.
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
