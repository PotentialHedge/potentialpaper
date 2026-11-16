'use client';

import Link from 'next/link';
import { ui } from '@/components/ui';
import { usePlugins } from '@/lib/plugins/client';

/**
 * The reader's plugins on `/settings`, in short: how many, whether any wait for approval, and the way to
 * `/settings/plugins`, where they are installed, turned on and off, updated and set.
 */
export function PluginsSection() {
  const { plugins, loaded } = usePlugins(null);
  const waiting = plugins.filter((p) => p.status === 'consent').length;
  const errors = plugins.filter((p) => p.status === 'error').length;
  return (
    <section className="mt-8 font-sans text-sm">
      <h2 className={ui.sectionHeading}>Plugins</h2>
      <p>
        {!loaded
          ? 'Loading your plugins…'
          : plugins.length === 0
            ? 'No plugins installed.'
            : `${plugins.length} installed${waiting ? `, ${waiting} waiting for your approval` : ''}${errors ? `, ${errors} can't run` : ''}.`}{' '}
        <Link href="/settings/plugins">Find, install and set up plugins →</Link>
      </p>
    </section>
  );
}
