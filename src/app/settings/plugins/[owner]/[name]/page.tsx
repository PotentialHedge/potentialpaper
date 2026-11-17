import type { Metadata } from 'next';
import { PluginDetail } from '../../PluginDetail';

type Params = { params: Promise<{ owner: string; name: string }> };

export const metadata: Metadata = { title: 'Plugin · Settings · PotentialPaper', robots: { index: false } };

/**
 * `/settings/plugins/<owner>/<name>`: one installed plugin's page: its settings (`contributes.settings`, drawn with
 * the standard controls), whether it runs, its version and update, what it may do, and where it shows.
 */
export default async function PluginSettingsPage({ params }: Params) {
  const { owner, name } = await params;
  return <PluginDetail id={`${decodeURIComponent(owner)}/${decodeURIComponent(name)}`} />;
}
