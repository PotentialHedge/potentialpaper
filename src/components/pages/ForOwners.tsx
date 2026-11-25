'use client';

import type { ReactNode } from 'react';
import { usePluginPage } from '@/components/plugins/PluginPage';
import { usePlugins } from '@/lib/plugins/client';

/**
 * `owner` for the page's owners, `children` for anyone else. The page is the same cached HTML for everyone, so whether
 * the viewer owns it is asked for here, after load (`viewer.isOwner`, as plugins see it).
 */
export function ForOwners({ owner, children }: { owner: ReactNode; children?: ReactNode }) {
  const page = usePluginPage();
  const { viewer } = usePlugins(page ? page.page.identifier : null);
  return viewer.isOwner ? owner : children;
}
