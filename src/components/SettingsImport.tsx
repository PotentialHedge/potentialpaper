'use client';

import { track } from '@/lib/track';
import Link from 'next/link';
import { useState } from 'react';
import { parseSettings, setInSettings } from '@/lib/settings';
import { clearLocalSettings, localSettingsText, saveSettings, useSettings } from '@/lib/settings/client';

/**
 * After signing in: settings this browser kept while signed out, offered for the account's settings.json. Their
 * keys go over the account's, one by one, so its own comments and other keys stay. Either answer clears the
 * browser's copy, so the offer doesn't come back.
 */
export function SettingsImport() {
  const settings = useSettings();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const local = settings.loaded && settings.signedIn ? localSettingsText() : null;
  if (!local) return null;

  async function importLocal(local: string) {
    setBusy(true);
    setError(null);
    let text = settings.text;
    for (const [key, value] of Object.entries(parseSettings(local))) text = setInSettings(text, key, value);
    try {
      await saveSettings(text);
      clearLocalSettings();
      track('settings_imported');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule bg-highlight px-6 py-2 font-sans text-[13px] narrow:px-4">
      <span>
        You changed <Link href="/settings">settings</Link> in this browser before signing in. Keep them in your account?
      </span>
      <button className="cursor-pointer font-semibold text-accent" disabled={busy} onClick={() => importLocal(local)}>
        import
      </button>
      <button className="cursor-pointer text-faint" disabled={busy} onClick={clearLocalSettings}>
        discard
      </button>
      {error && <span className="w-full whitespace-pre-wrap text-down">{error}</span>}
    </div>
  );
}
