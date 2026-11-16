'use client';

import { type FormEvent, useState } from 'react';
import { ui } from '@/components/ui';
import { addDevPlugin, installPlugin, removeDevPlugin, usePlugins } from '@/lib/plugins/client';
import { useSettings } from '@/lib/settings/client';

const STATUS: Record<string, string> = {
  ready: 'runs',
  consent: 'waits for your approval, on a page it shows on',
  blocked: 'blocked by the site',
  disabled: 'turned off',
  error: "can't run",
};

/**
 * The reader's plugins on `/settings`: what is installed and whether it runs, installing one by its GitHub source,
 * and loading one from a dev server on this machine. Enough to use plugins before `/settings/plugins`
 * (`handoffs/plugins.md` Phase 3) adds discovery, updates and per-plugin settings. Turning one off or removing it is
 * an edit of the `plugins` key, in the raw file below.
 */
export function PluginsSection() {
  const { signedIn, loaded } = useSettings();
  const { plugins } = usePlugins(null);
  const [source, setSource] = useState('');
  const [devUrl, setDevUrl] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function install(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const installed = await installPlugin(source);
      setNote(`Installed ${installed.plugin?.manifest.name ?? installed.source}. Approve it on a page it shows on.`);
      setSource('');
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function loadDev(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    try {
      addDevPlugin(devUrl);
      setDevUrl('');
    } catch (err) {
      setNote((err as Error).message);
    }
  }

  return (
    <section className="mt-8">
      <h2 className={ui.sectionHeading}>Plugins</h2>
      {plugins.length === 0 ? (
        <p className={ui.fine}>No plugins installed.</p>
      ) : (
        <ul className="space-y-1.5 font-sans text-sm">
          {plugins.map((p) => (
            <li key={p.source}>
              {p.plugin ? (
                <a href={p.plugin.sourceUrl} rel="noopener noreferrer" target="_blank">
                  {p.plugin.manifest.name} {p.plugin.manifest.version}
                </a>
              ) : (
                <span className={ui.mono}>{p.source}</span>
              )}{' '}
              <span className={ui.fine}>
                {p.from === 'site' ? 'for everyone, ' : p.from === 'dev' ? 'from your dev server, ' : ''}
                {STATUS[p.status]}
                {p.plugin?.commit ? `, at ${p.plugin.commit.slice(0, 7)}` : ''}
              </span>
              {p.error && <span className="block text-xs whitespace-pre-line text-accent">{p.error}</span>}
              {p.from === 'dev' && (
                <button
                  type="button"
                  className={`${ui.linkBtn} ml-2 text-xs`}
                  onClick={() => removeDevPlugin(p.source)}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {loaded && signedIn && (
        <form onSubmit={install} className="mt-3 flex gap-2">
          <input
            className={ui.input}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="github:owner/repo@v1.0.0, or owner/repo"
            aria-label="A plugin's GitHub source"
          />
          <button type="submit" className={ui.linkBtn} disabled={busy || !source.trim()}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </form>
      )}
      <details className="mt-2 font-sans text-sm">
        <summary className="cursor-pointer text-muted">Load a plugin from your dev server</summary>
        <p className={ui.fine}>
          It runs in this browser only, unpinned, and reloads with your server. Its server must answer with CORS.
        </p>
        <form onSubmit={loadDev} className="mt-2 flex gap-2">
          <input
            className={ui.input}
            value={devUrl}
            onChange={(e) => setDevUrl(e.target.value)}
            placeholder="http://localhost:5173/"
            aria-label="Your dev server's address"
          />
          <button type="submit" className={ui.linkBtn} disabled={!devUrl.trim()}>
            Load
          </button>
        </form>
      </details>
      {note && <p className="mt-2 font-sans text-sm whitespace-pre-line">{note}</p>}
    </section>
  );
}
