import type { Metadata } from 'next';
import { PluginsSettings } from './PluginsSettings';

export const metadata: Metadata = { title: 'Plugins · Settings · PotentialPaper', robots: { index: false } };

/**
 * `/settings/plugins` (`handoffs/plugins.md` Phase 3): the reader's plugins (each linking to its own page of settings
 * and details), plugins to discover, installing one by its source, and loading one from a dev server. The same HTML
 * for everyone; whose plugins they are is decided in the browser.
 */
export default function PluginsSettingsPage() {
  return <PluginsSettings />;
}
