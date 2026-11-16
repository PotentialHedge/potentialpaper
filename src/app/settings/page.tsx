import type { Metadata } from 'next';
import { ui } from '@/components/ui';
import { PluginsSection } from './PluginsSection';
import { SettingsEditor } from './SettingsEditor';

export const metadata: Metadata = { title: 'Settings · PotentialPaper', robots: { index: false } };

/**
 * `/settings`: the reader's settings.json (DESIGN.md §10), as a form made from the settings' schema and as the raw
 * file. The same for everyone; whose file it is (the account's, or this browser's when signed out) is decided in
 * the browser.
 */
export default function SettingsPage() {
  return (
    <main className={ui.page}>
      <h1 className="mt-6 text-[26px] font-normal">Settings</h1>
      <SettingsEditor />
      <PluginsSection />
    </main>
  );
}
