import type { Metadata } from 'next';
import Link from 'next/link';
import { ui } from '@/components/ui';
import { PluginsSettings } from './PluginsSettings';

export const metadata: Metadata = { title: 'Plugins · Settings · PotentialPaper', robots: { index: false } };

/**
 * `/settings/plugins` (`handoffs/plugins.md` Phase 3): the reader's plugins (on and off, version and updates, their
 * settings, what they may do, removing them), plugins to discover, installing one by its source, and loading one
 * from a dev server. The same HTML for everyone; whose plugins they are is decided in the browser.
 */
export default function PluginsSettingsPage() {
  return (
    <main className={ui.page}>
      <p className="mt-6 font-sans text-sm">
        <Link href="/settings">Settings</Link> ›
      </p>
      <h1 className="mt-1 text-[26px] font-normal">Plugins</h1>
      <PluginsSettings />
    </main>
  );
}
