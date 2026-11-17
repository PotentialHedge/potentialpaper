import type { Metadata } from 'next';
import { ui } from '@/components/ui';
import { PluginPageView } from '@/components/plugins/PluginPageView';

export const metadata: Metadata = { title: 'Plugin · PotentialPaper', robots: { index: false } };

/**
 * `/x/<owner>/<name>/<page>/…`: a whole page of a plugin's own (its manifest's `contributes.pages`), drawn in one
 * frame. Which plugins the reader has is known only in the browser, so the page is the same shell for everyone.
 */
export default async function PluginRoute({ params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.map(decodeURIComponent);
  return (
    <main className={ui.paperPage}>
      <PluginPageView path={path} />
    </main>
  );
}
