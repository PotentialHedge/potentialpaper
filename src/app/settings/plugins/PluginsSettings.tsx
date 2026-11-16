'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ui } from '@/components/ui';
import {
  addDevPlugin,
  type DiscoveredPlugin,
  type Discovery,
  fetchDiscovered,
  fetchUpdates,
  grantPlugin,
  installPlugin,
  type PluginUpdate,
  removeDevPlugin,
  revokePlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePluginTo,
  usePlugins,
} from '@/lib/plugins/client';
import type { InstalledPlugin } from '@/lib/plugins/installed';
import { PERMISSIONS, type PluginPermission } from '@/lib/plugins/manifest';
import { parsePluginSource, sourceKey } from '@/lib/plugins/sources';
import {
  parseSettings,
  qualify,
  resolveSettings,
  sameValue,
  sanitizeSettingValue,
  type PluginSettingSpec,
} from '@/lib/settings';
import { setSetting, useSettings } from '@/lib/settings/client';

type Note = { ok: boolean; text: string } | null;

const STATUS: Record<InstalledPlugin['status'], string> = {
  ready: 'runs',
  consent: 'waits for your approval',
  blocked: 'blocked by the site',
  disabled: 'turned off',
  error: "can't run",
};

const FROM: Record<InstalledPlugin['from'], string> = {
  site: 'installed by the site for everyone',
  user: '',
  dev: 'from your dev server, in this browser only',
};

/** The site's origin, in the browser only (the page is the same HTML everywhere). */
function useOrigin(): string {
  return useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => '',
  );
}

export function PluginsSettings() {
  const settings = useSettings();
  const { plugins, loaded } = usePlugins(null);
  const [updates, setUpdates] = useState<PluginUpdate[]>([]);
  const [note, setNote] = useState<Note>(null);
  const origin = useOrigin();
  const signedIn = settings.loaded && settings.signedIn;

  const checkUpdates = useCallback(() => {
    if (!signedIn) return;
    fetchUpdates().then(setUpdates, () => setUpdates([]));
  }, [signedIn]);
  // Check again whenever the installed list changes: after an install, an update or a removal.
  const installedKey = plugins.map((p) => `${p.source}@${p.plugin?.commit ?? ''}`).join(' ');
  useEffect(checkUpdates, [checkUpdates, installedKey]);

  const installed = useMemo(() => new Set(plugins.map((p) => p.source)), [plugins]);

  return (
    <div className="font-sans text-sm">
      <p className="mb-2 text-muted">
        Plugins add panels to pages: a paper, a venue, a topic, an organisation or a person. Each comes from a public
        GitHub repo, pinned to a commit, and runs in a frame of its own that sees only what the site gives it. A plugin
        runs once you approve what it asks for.
      </p>
      <p className="mb-6 text-muted">
        To build one, ask your agent:{' '}
        <q className="text-ink">Read {origin || 'this site'}/plugins.md and build me a PotentialPaper plugin.</q> The
        guide is at <a href="/plugins.md">/plugins.md</a>.
      </p>
      {note && <p className={`${ui.note(note.ok)} mb-3 whitespace-pre-line`}>{note.text}</p>}

      <section className="mb-8">
        <h2 className={ui.sectionHeading}>Installed</h2>
        {!loaded ? (
          <p className={ui.empty}>Loading your plugins…</p>
        ) : plugins.length === 0 ? (
          <p className={ui.fine}>No plugins installed. Find one below, or add one by its source.</p>
        ) : (
          <ul className="space-y-5">
            {plugins.map((p) => (
              <InstalledItem
                key={p.source}
                plugin={p}
                signedIn={signedIn}
                update={updates.find((u) => u.source === p.source) ?? null}
                onNote={setNote}
                onChanged={checkUpdates}
              />
            ))}
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
    </div>
  );
}

/** One installed plugin: what it is, whether it runs, its version and update, what it may do, and its settings. */
function InstalledItem({
  plugin: p,
  signedIn,
  update,
  onNote,
  onChanged,
}: {
  plugin: InstalledPlugin;
  signedIn: boolean;
  update: PluginUpdate | null;
  onNote: (n: Note) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Extract<
    Awaited<ReturnType<typeof updatePluginTo>>,
    { status: 'consent' }
  > | null>(null);
  const manifest = p.plugin?.manifest;
  const name = manifest?.name ?? p.source;

  async function run(what: () => Promise<unknown>, done?: string) {
    setBusy(true);
    onNote(null);
    try {
      await what();
      if (done) onNote({ ok: true, text: done });
    } catch (err) {
      onNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function updateTo(approve: boolean) {
    if (!update) return;
    await run(async () => {
      const result = await updatePluginTo(p.source, update.latest.tag, approve);
      if (result.status === 'consent') {
        setAsking(result);
        return;
      }
      setAsking(null);
      onNote({ ok: true, text: `Updated ${name} to ${update.latest.version}.` });
      onChanged();
    });
  }

  const missing = new Set<string>([...p.missing.permissions, ...p.missing.network]);
  const canToggle = signedIn && p.from !== 'dev';

  return (
    <li className="border-t border-rule pt-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {canToggle && (
          <input
            type="checkbox"
            checked={p.enabled}
            disabled={busy}
            aria-label={`${name} on`}
            onChange={(e) => run(() => setPluginEnabled(p, e.target.checked))}
          />
        )}
        <span className="font-semibold">{name}</span>
        {manifest && <span className="text-muted">{manifest.version}</span>}
        {p.plugin?.commit && (
          <a className={ui.mono} href={p.plugin.sourceUrl} rel="noopener noreferrer" target="_blank">
            {p.ref ? `${p.ref} · ` : ''}
            {p.plugin.commit.slice(0, 7)}
          </a>
        )}
        <span className={p.status === 'ready' ? 'text-up' : p.status === 'error' ? 'text-down' : 'text-muted'}>
          {STATUS[p.status]}
        </span>
        <span className="flex-1" />
        {p.from === 'dev' ? (
          <button className={ui.linkBtn} onClick={() => removeDevPlugin(p.source)}>
            Remove
          </button>
        ) : (
          signedIn &&
          p.from === 'user' && (
            <button
              className={ui.linkBtn}
              disabled={busy}
              onClick={() => run(() => uninstallPlugin(p.source), `Removed ${name}.`)}
            >
              Remove
            </button>
          )
        )}
      </div>
      <p className={`${ui.fine} mt-0.5`}>
        {[p.plugin?.id ?? p.source, manifest?.author && `by ${manifest.author}`, FROM[p.from]]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {manifest?.description && <p className="mt-1">{manifest.description}</p>}
      {p.error && <p className="mt-1 text-xs whitespace-pre-line text-down">{p.error}</p>}

      {update && signedIn && !asking && (
        <p className="mt-2">
          Version {update.latest.version} is out.{' '}
          <button className={ui.linkBtn} disabled={busy} onClick={() => updateTo(false)}>
            Update
          </button>
        </p>
      )}
      {asking && (
        <div className={`${ui.box} mt-2`}>
          <p>
            {asking.to.name} {asking.to.version} asks for more than you approved:
          </p>
          <Asks permissions={asking.missing.permissions} network={asking.missing.network} />
          <div className="mt-2 flex gap-4">
            <button className={ui.btn({ inline: true, flush: true })} disabled={busy} onClick={() => updateTo(true)}>
              Approve and update
            </button>
            <button className={ui.linkBtn} disabled={busy} onClick={() => setAsking(null)}>
              Keep {manifest?.version}
            </button>
          </div>
        </div>
      )}

      {manifest && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted">
            What it may do{p.status === 'consent' ? ' (not approved yet)' : ''}
          </summary>
          {manifest.permissions.length === 0 && manifest.network.length === 0 ? (
            <p className={ui.fine}>It reads nothing beyond the page it is on, and sends nothing anywhere.</p>
          ) : (
            <Asks
              permissions={manifest.permissions as PluginPermission[]}
              network={manifest.network}
              pending={missing}
            />
          )}
          {signedIn && p.plugin?.commit && p.from === 'user' && p.status === 'consent' && (
            <button
              className={ui.linkBtn}
              disabled={busy}
              onClick={() => run(() => grantPlugin(p.plugin!.id, p.plugin!.commit!), `Approved ${name}.`)}
            >
              Approve
            </button>
          )}
          {signedIn && p.plugin && p.from === 'user' && p.status === 'ready' && (
            <button
              className={ui.linkBtn}
              disabled={busy}
              onClick={() => run(() => revokePlugin(p.plugin!.id), `Withdrew your approval of ${name}.`)}
            >
              Withdraw approval
            </button>
          )}
          <Contributes plugin={p} />
        </details>
      )}

      {manifest && p.plugin && Object.keys(manifest.contributes.settings).length > 0 && (
        <PluginSettingsForm pluginId={p.plugin.id} specs={manifest.contributes.settings} onNote={onNote} />
      )}
    </li>
  );
}

/** What a plugin asks for, in the consent prompt's words; `pending` marks what isn't approved yet. */
function Asks({
  permissions,
  network,
  pending,
}: {
  permissions: PluginPermission[];
  network: string[];
  pending?: Set<string>;
}) {
  return (
    <ul className="mt-1 list-disc pl-5">
      {permissions.map((perm) => (
        <li key={perm}>
          {PERMISSIONS[perm] ?? perm} <code className="text-xs text-faint">{perm}</code>
          {pending?.has(perm) && <span className="text-muted"> · not approved yet</span>}
        </li>
      ))}
      {network.map((origin) => (
        <li key={origin}>
          Send and receive data at <code className={ui.mono}>{origin}</code>, its own server
          {pending?.has(origin) && <span className="text-muted"> · not approved yet</span>}
        </li>
      ))}
    </ul>
  );
}

/** Where a plugin shows: its panels by kind and slot, and its own pages. */
function Contributes({ plugin }: { plugin: InstalledPlugin }) {
  const manifest = plugin.plugin!.manifest;
  const { panels, pages } = manifest.contributes;
  if (panels.length === 0 && pages.length === 0) return null;
  return (
    <ul className="mt-2 text-muted">
      {panels.map((panel) => (
        <li key={panel.id}>
          Panel “{panel.title}” on {panel.kinds.join(', ')} pages
          {panel.when && (
            <>
              , when <code className="text-xs">{panel.when}</code>
            </>
          )}
        </li>
      ))}
      {pages.map((page) => (
        <li key={page.id}>
          Page <Link href={`/x/${plugin.plugin!.id}/${page.id}`}>{page.title}</Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * A plugin's settings (`contributes.settings`), as a form drawn from their specs: a box for `boolean`, a list for
 * `enum`, a field for `string` and `number`. Each change edits one key of settings.json
 * (`<plugin id>.<name>`), and a value equal to the layer below is taken out of the file.
 */
export function PluginSettingsForm({
  pluginId,
  specs,
  onNote,
}: {
  pluginId: string;
  specs: Record<string, PluginSettingSpec>;
  onNote: (n: Note) => void;
}) {
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const own = useMemo(() => parseSettings(settings.text), [settings.text]);
  const below = useMemo(
    () => resolveSettings({ site: parseSettings(settings.siteText) }, settings.plugins),
    [settings.siteText, settings.plugins],
  );

  async function change(key: string, spec: PluginSettingSpec, value: unknown) {
    setBusy(true);
    onNote(null);
    try {
      const base = below[key] ?? spec.default;
      await setSetting(key, sameValue(value, base) ? undefined : value);
    } catch (err) {
      onNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="mt-3 max-w-[520px]" disabled={busy || !settings.loaded}>
      <legend className="mb-1 text-xs text-muted">Settings</legend>
      {Object.entries(specs).map(([name, spec]) => {
        const key = qualify(pluginId, name);
        // A dev plugin's settings aren't known to the server, so its values are read here.
        const value = settings.values[key] ?? sanitizeSettingValue(spec, own[key]) ?? spec.default;
        return (
          <div key={name} className="mb-3">
            <SpecField name={name} spec={spec} value={value} onChange={(v) => change(key, spec, v)} />
            <p className={`${ui.fine} mt-0.5`}>
              {spec.description ? `${spec.description} ` : ''}
              <code className="font-mono">{key}</code>
              {Object.hasOwn(own, key) && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className={ui.linkBtn}
                    onClick={() => change(key, spec, below[key] ?? spec.default)}
                  >
                    reset
                  </button>
                </>
              )}
            </p>
          </div>
        );
      })}
    </fieldset>
  );
}

function SpecField({
  name,
  spec,
  value,
  onChange,
}: {
  name: string;
  spec: PluginSettingSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null || value === undefined ? '' : String(value));

  if (spec.type === 'boolean') {
    return (
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {name}
      </label>
    );
  }
  if (spec.type === 'enum') {
    return (
      <label className="flex items-baseline gap-2">
        <span>{name}</span>
        <select
          className="border border-rule bg-white p-1 font-sans text-sm"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        >
          {spec.values.map((v, i) => (
            <option key={v} value={v}>
              {spec.labels?.[i] ?? v}
            </option>
          ))}
        </select>
      </label>
    );
  }

  // Strings and numbers are saved when you leave the field or press Enter.
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (spec.type === 'string') {
      if (draft !== value) onChange(draft);
      return;
    }
    const n = draft.trim() === '' ? null : Number(draft);
    if (n === null && spec.default !== null) return;
    if (n !== null && !Number.isFinite(n)) return;
    if (n !== value) onChange(n);
  };
  return (
    <label className="block">
      <span>{name}</span>
      <input
        className={`${ui.input} mt-1 mb-0`}
        type={spec.type === 'number' ? 'number' : 'text'}
        min={spec.type === 'number' ? spec.minimum : undefined}
        max={spec.type === 'number' ? spec.maximum : undefined}
        maxLength={spec.type === 'string' ? spec.maxLength : undefined}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
    </label>
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
        text: `Installed ${installed.plugin?.manifest.name ?? installed.source}${installed.ref ? ` ${installed.ref}` : ''}. Approve it above, or on a page it shows on.`,
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
      <h2 className={ui.sectionHeading}>Add by source</h2>
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
        text: `Installed ${done.plugin?.manifest.name ?? p.repo}${done.ref ? ` ${done.ref}` : ''}. Approve it above, or on a page it shows on.`,
      });
    } catch (err) {
      onNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-8">
      <h2 className={ui.sectionHeading}>Discover</h2>
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
      <h2 className={ui.sectionHeading}>Load from localhost</h2>
      <p className={`${ui.fine} mt-0 mb-2`}>
        For building a plugin: it runs in this browser only, unpinned, and needs no approval. Serve its folder with CORS
        on (<code className="font-mono">npx http-server . -p 5174 --cors</code>); see{' '}
        <a href="/plugins.md#develop">the guide</a>.
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
