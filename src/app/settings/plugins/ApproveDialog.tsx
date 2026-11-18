'use client';

import { useEffect, useRef, useState } from 'react';
import { ui } from '@/components/ui';
import { grantPlugin } from '@/lib/plugins/client';
import type { InstalledPlugin } from '@/lib/plugins/installed';
import type { PluginPermission } from '@/lib/plugins/manifest';
import { Asks } from './PluginDetail';

/**
 * Asks to approve a plugin just installed, in a popup: what it may do, then Approve or Later. Later leaves it
 * waiting, to approve on its page or on a page it shows on.
 */
export function ApproveDialog({
  installed,
  onDone,
}: {
  installed: InstalledPlugin;
  onDone: (approved: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plugin = installed.plugin!;
  const { manifest } = plugin;
  const asksNothing = manifest.permissions.length === 0 && manifest.network.length === 0 && !plugin.bot;

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await grantPlugin(plugin.id, plugin.commit!);
      onDone(true);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      // Escape closes it: that is Later.
      onClose={() => !busy && onDone(false)}
      aria-labelledby="approve-title"
      className="m-auto w-[min(480px,calc(100vw-32px))] border border-frame bg-card p-0 text-left font-sans text-sm text-ink shadow-sm backdrop:bg-black/30"
    >
      <div className="p-5">
        <h2 id="approve-title" className={ui.boxHeading}>
          Approve {manifest.name}?
        </h2>
        <p className="mt-1">
          {asksNothing ? 'It reads only the page it is on and sends nothing anywhere.' : 'It may:'}
        </p>
        {!asksNothing && (
          <Asks permissions={manifest.permissions as PluginPermission[]} network={manifest.network} bot={plugin.bot} />
        )}
        {error && <p className={`${ui.note(false)} mt-2`}>{error}</p>}
        <div className="mt-4 flex items-center justify-end gap-4">
          <button type="button" className={ui.linkBtn} disabled={busy} onClick={() => dialog.current?.close()}>
            Later
          </button>
          <button type="button" className={ui.btn({ inline: true, flush: true })} disabled={busy} onClick={approve}>
            {busy ? 'Approving…' : 'Approve'}
          </button>
        </div>
      </div>
    </dialog>
  );
}
