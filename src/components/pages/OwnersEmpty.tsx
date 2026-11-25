'use client';

import type { ReactNode } from 'react';
import { ui } from '@/components/ui';
import { usePluginPage } from '@/components/plugins/PluginPage';
import { usePlugins } from '@/lib/plugins/client';

/**
 * The owners' part while they have written nothing: for an owner, an invitation to write it; for anyone else, `children`
 * (its label and "Nothing yet."). The page is the same cached HTML for everyone, so whether the viewer owns it is asked
 * for here, after load (`viewer.isOwner`, as plugins see it).
 */
export function OwnersEmpty({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  const page = usePluginPage();
  const { viewer } = usePlugins(page ? page.page.identifier : null);
  if (!viewer.isOwner) return children;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-dashed border-frame px-4 py-3 font-sans text-[13px]">
      <p className="min-w-0 flex-1 basis-64 text-muted">
        <strong className="text-ink">{title}</strong> {hint}
      </p>
      <a href="#edit" rel="nofollow" className={ui.btn({ inline: true, flush: true })}>
        Start writing
      </a>
    </div>
  );
}
