'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BotNote } from '@/components/plugins/BotNote';
import { Switch } from '@/components/controls';
import { SettingsList, useSettingItems } from '@/components/settings/SettingsList';
import { ui } from '@/components/ui';
import {
  fetchUpdates,
  grantPlugin,
  type PluginUpdate,
  removeDevPlugin,
  revokePlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePluginTo,
} from '@/lib/plugins/client';
import { type InstalledPlugin, PERSONAL_PERMISSIONS, type PluginBot } from '@/lib/plugins/installed';
import { PERMISSIONS, type PluginPermission } from '@/lib/plugins/manifest';
import { pluginCategory } from '@/lib/settings/form';

type Note = { ok: boolean; text: string } | null;

export const STATUS: Record<InstalledPlugin['status'], string> = {
  ready: 'Runs',
  consent: 'Waits for your approval',
  blocked: 'Blocked by the site',
  disabled: 'Turned off',
  error: "Can't run",
};

export const STATUS_COLOR: Record<InstalledPlugin['status'], string> = {
  ready: 'text-up',
  consent: 'text-accent',
  blocked: 'text-muted',
  disabled: 'text-muted',
  error: 'text-down',
};

const FROM: Record<InstalledPlugin['from'], string> = {
  site: 'Installed by the site for everyone',
  user: '',
  dev: 'From your dev server, in this browser only',
};

/** One installed plugin's page: what it is, whether it runs, its settings, its version, what it may do. */
export function PluginDetail({ id }: { id: string }) {
  const router = useRouter();
  const { items, loaded, signedIn, plugins } = useSettingItems();
  const p = plugins.find((x) => x.plugin?.id === id);
  const [update, setUpdate] = useState<PluginUpdate | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<Extract<
    Awaited<ReturnType<typeof updatePluginTo>>,
    { status: 'consent' }
  > | null>(null);

  const commit = p?.plugin?.commit ?? null;
  // By id, not by the entry shown: a copy loaded from localhost stands in for the installed one, which still updates.
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    fetchUpdates(id).then(
      (list) => !cancelled && setUpdate(list[0] ?? null),
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // Again after an update moves it to another commit.
  }, [signedIn, id, commit]);

  if (!loaded) return <p className={ui.empty}>Loading the plugin…</p>;
  if (!p?.plugin) {
    return (
      <>
        <h2 className="font-serif text-xl font-normal">{id}</h2>
        <p className="mt-2">
          It isn&apos;t installed. <Link href="/settings/plugins">Find and install plugins →</Link>
        </p>
      </>
    );
  }

  const plugin = p.plugin;
  const manifest = plugin.manifest;
  const settings = items.filter((i) => i.category === pluginCategory(plugin.id));
  const missing = new Set<string>([...p.missing.permissions, ...p.missing.network]);
  const canToggle = signedIn && p.from !== 'dev';

  async function run(what: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setNote(null);
    try {
      await what();
      if (done) setNote({ ok: true, text: done });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function updateTo(approve: boolean) {
    if (!update) return;
    await run(async () => {
      const result = await updatePluginTo(update.source, update.latest.tag, approve);
      if (result.status === 'consent') {
        setAsking(result);
        return;
      }
      setAsking(null);
      setUpdate(null);
      setNote({ ok: true, text: `Updated to ${update.latest.version}.` });
    });
  }

  const canApprove =
    signedIn &&
    plugin.commit &&
    (p.from === 'user' ? p.status === 'consent' : p.status === 'ready' && p.missing.permissions.length > 0);
  const canWithdraw =
    signedIn &&
    p.status === 'ready' &&
    (p.from === 'user' ||
      (p.from === 'site' &&
        manifest.permissions.some((perm) => PERSONAL_PERMISSIONS.includes(perm)) &&
        p.missing.permissions.length === 0));

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="font-serif text-xl font-normal">{manifest.name}</h2>
        <span className="text-muted">{manifest.version}</span>
        <span className="flex-1" />
        {canToggle && (
          <label className="flex cursor-pointer items-center gap-2">
            <span className={STATUS_COLOR[p.status]}>{STATUS[p.status]}</span>
            <Switch
              checked={p.enabled}
              disabled={busy}
              aria-label={`${manifest.name} on`}
              onCheckedChange={(on) => run(() => setPluginEnabled(p, on))}
            />
          </label>
        )}
        {!canToggle && <span className={STATUS_COLOR[p.status]}>{STATUS[p.status]}</span>}
      </div>
      <p className={`${ui.fine} mt-0.5`}>
        {[plugin.id, manifest.author && `by ${manifest.author}`, FROM[p.from]].filter(Boolean).join(' · ')}
        {plugin.commit && (
          <>
            {' · '}
            <a href={plugin.sourceUrl} rel="noopener noreferrer" target="_blank">
              {p.ref ? `${p.ref} · ` : ''}
              {plugin.commit.slice(0, 7)}
            </a>
          </>
        )}
      </p>
      {manifest.description && <p className="mt-2 text-subtle">{manifest.description}</p>}
      {p.error && <p className="mt-2 text-xs whitespace-pre-line text-down">{p.error}</p>}
      {note && <p className={`${ui.note(note.ok)} whitespace-pre-line`}>{note.text}</p>}

      {(p.status === 'consent' || (update && !asking) || asking) && (
        <div className={`${ui.box} mt-3`}>
          {p.status === 'consent' && !asking && (
            <>
              <p>It runs once you approve what it asks for:</p>
              <Asks
                permissions={manifest.permissions as PluginPermission[]}
                network={manifest.network}
                pending={missing}
                bot={plugin.bot}
              />
              {canApprove && (
                <button
                  className={ui.btn({ inline: true })}
                  disabled={busy}
                  onClick={() => run(() => grantPlugin(plugin.id, plugin.commit!), `Approved ${manifest.name}.`)}
                >
                  Approve
                </button>
              )}
            </>
          )}
          {update && signedIn && !asking && p.status !== 'consent' && (
            <p>
              Version {update.latest.version} is out. You have {update.current.version}.{' '}
              <button className={ui.linkBtn} disabled={busy} onClick={() => updateTo(false)}>
                Update
              </button>
            </p>
          )}
          {asking && (
            <>
              <p>
                {asking.to.name} {asking.to.version} asks for more than you approved:
              </p>
              <Asks permissions={asking.missing.permissions} network={asking.missing.network} />
              <div className="mt-2 flex gap-4">
                <button
                  className={ui.btn({ inline: true, flush: true })}
                  disabled={busy}
                  onClick={() => updateTo(true)}
                >
                  Approve and update
                </button>
                <button className={ui.linkBtn} disabled={busy} onClick={() => setAsking(null)}>
                  Keep {manifest.version}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <h3 className="mt-8 mb-1 font-serif text-lg font-normal">Settings</h3>
      {settings.length === 0 ? (
        <p className={ui.fine}>It has no settings.</p>
      ) : (
        <div className="pl-4">
          <SettingsList items={settings} />
        </div>
      )}

      <h3 className="mt-8 mb-1 font-serif text-lg font-normal">What it may do</h3>
      {manifest.permissions.length === 0 && manifest.network.length === 0 && !plugin.bot ? (
        <p>It reads nothing beyond the page it is on, and sends nothing anywhere.</p>
      ) : (
        <Asks
          permissions={manifest.permissions as PluginPermission[]}
          network={manifest.network}
          pending={missing}
          bot={plugin.bot}
        />
      )}
      {canWithdraw && (
        <button
          className={`${ui.linkBtn} mt-1`}
          disabled={busy}
          onClick={() => run(() => revokePlugin(plugin.id), `Withdrew your approval of ${manifest.name}.`)}
        >
          Withdraw approval
        </button>
      )}

      <Contributes plugin={p} />

      {(p.from === 'dev' || (signedIn && p.from === 'user')) && (
        <>
          <h3 className="mt-8 mb-1 font-serif text-lg font-normal">Remove</h3>
          <p>
            {p.from === 'dev'
              ? 'Stop loading it from your dev server.'
              : 'Uninstall it. Its settings stay in your settings.json until you remove them there.'}
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              className={ui.btn({ ghost: true, inline: true })}
              disabled={busy}
              onClick={async () => {
                if (p.from === 'dev') removeDevPlugin(p.source);
                else await run(() => uninstallPlugin(p.source));
                router.push('/settings/plugins');
              }}
            >
              Remove {manifest.name}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** What a plugin asks for, in the consent prompt's words; `pending` marks what isn't approved yet. */
export function Asks({
  permissions,
  network,
  pending,
  bot,
}: {
  permissions: PluginPermission[];
  network: string[];
  pending?: Set<string>;
  bot?: PluginBot | null;
}) {
  return (
    <ul className="mt-1 list-disc pl-5">
      {permissions.map((perm) => (
        <li key={perm}>
          {PERMISSIONS[perm] ?? perm}
          {pending?.has(perm) && <span className="text-muted"> · not approved yet</span>}
        </li>
      ))}
      {network.map((origin) => (
        <li key={origin}>
          Send and receive data at <code className={ui.mono}>{origin}</code>, its own server
          {pending?.has(origin) && <span className="text-muted"> · not approved yet</span>}
        </li>
      ))}
      <BotNote bot={bot} />
    </ul>
  );
}

/** Where a plugin shows: its panels by kind and slot, and its own pages. */
function Contributes({ plugin }: { plugin: InstalledPlugin }) {
  const manifest = plugin.plugin!.manifest;
  const { panels, pages } = manifest.contributes;
  if (panels.length === 0 && pages.length === 0) return null;
  return (
    <>
      <h3 className="mt-8 mb-1 font-serif text-lg font-normal">Where it shows</h3>
      <ul className="list-disc pl-5">
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
    </>
  );
}
