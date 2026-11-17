import type { ReactNode } from 'react';
import { ui } from '@/components/ui';
import { SettingsShell } from './SettingsShell';

/**
 * `/settings` and its pages (DESIGN.md §10): the reader's settings.json as VS Code's settings editor shows its own,
 * a page per category and per installed plugin, with a search over all of them. The same HTML for everyone; whose
 * settings they are (the account's, or this browser's when signed out) is decided in the browser.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <main className={ui.page}>
      <SettingsShell>{children}</SettingsShell>
    </main>
  );
}
