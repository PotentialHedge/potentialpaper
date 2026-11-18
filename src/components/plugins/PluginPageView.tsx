'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ui } from '@/components/ui';
import { usePlugins } from '@/lib/plugins/client';
import { PluginFrame, type ReadyPlugin } from './PluginFrame';
import { ConsentPrompt } from './PluginPanel';

/**
 * A plugin's own page (`/x/<owner>/<name>/<page>/…`): the plugin found among the reader's, its page by id, and the
 * rest of the path handed to the frame (`pp.context.surface.path`), so a plugin can route within its page.
 */
export function PluginPageView({ path }: { path: string[] }) {
  const { loaded, plugins, viewer } = usePlugins(null);
  const [owner, name, pageId, ...rest] = path;
  const id = `${owner}/${name}`;
  const plugin = plugins.find((p) => p.plugin?.id === id && (p.status === 'ready' || p.status === 'consent')) as
    ReadyPlugin | undefined;
  if (!loaded)
    return (
      <Column>
        <p className={ui.empty}>Loading…</p>
      </Column>
    );
  const page = plugin?.plugin.manifest.contributes.pages.find((p) => p.id === pageId);
  if (!plugin || !page) {
    return (
      <Column>
        <p className={ui.empty}>
          {plugin
            ? `${plugin.plugin.manifest.name} has no page “${pageId ?? ''}”.`
            : `You don’t have the plugin ${id} installed.`}{' '}
          <Link href="/settings/plugins">Plugins</Link>
        </p>
      </Column>
    );
  }
  const frame = (fill: boolean) => (
    <PluginFrame
      plugin={plugin}
      surface={{ type: 'page', id: page.id, path: rest }}
      page={null}
      viewer={viewer}
      title={`${page.title} (${plugin.plugin.manifest.name})`}
      fill={fill}
    />
  );
  if (page.layout === 'full' && plugin.status === 'ready') return <FullWindow>{frame(true)}</FullWindow>;
  return (
    <Column>
      <article>
        <h1 className="mt-6 text-center text-[26px] leading-tight font-normal">{page.title}</h1>
        <p className={`${ui.fine} mb-5 text-center font-sans`}>
          from the plugin{' '}
          <a href={plugin.plugin.sourceUrl} rel="noopener noreferrer" target="_blank">
            {plugin.plugin.manifest.name}
          </a>
        </p>
        {plugin.status === 'consent' ? <ConsentPrompt plugin={plugin} signedIn={viewer.signedIn} /> : frame(false)}
      </article>
    </Column>
  );
}

function Column({ children }: { children: React.ReactNode }) {
  return <div className={ui.page}>{children}</div>;
}

/**
 * A `"layout": "full"` page: the window below the site's bar, edge to edge. The bar's height changes as it wraps on a
 * narrow screen, so it is measured.
 */
function FullWindow({ children }: { children: React.ReactNode }) {
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => {
    const bar = document.querySelector('body > header');
    const measure = () => setTop(bar ? Math.round(bar.getBoundingClientRect().bottom + window.scrollY) : 0);
    measure();
    const observer = new ResizeObserver(measure);
    if (bar) observer.observe(bar);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return (
    <div className="border-t border-rule" style={{ height: top === null ? '80dvh' : `calc(100dvh - ${top}px)` }}>
      {children}
    </div>
  );
}
