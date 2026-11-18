import { describe, expect, it } from 'vitest';
import { pluginNavItems } from '@/lib/nav';
import type { InstalledPlugin } from '@/lib/plugins/installed';
import { validateManifest } from '@/lib/plugins/manifest';
import { checkSettings, resolveSettings } from '@/lib/settings';

const manifest = (pages: unknown[]) =>
  validateManifest({
    id: 'o/map',
    name: 'Map',
    version: '1.0.0',
    apiVersion: 1,
    main: 'index.html',
    contributes: { pages },
  });

describe('navbar', () => {
  it("takes a plugin page's nav link, by its title or its own text", () => {
    const report = manifest([
      { id: 'map', title: 'Paper map', nav: 'map' },
      { id: 'other', title: 'Other', nav: true },
      { id: 'quiet', title: 'Quiet' },
    ]);
    expect(report.errors).toEqual([]);
    const plugin = (status: InstalledPlugin['status']) =>
      ({ status, plugin: { id: 'o/map', manifest: report.manifest! } }) as InstalledPlugin;
    expect(pluginNavItems([plugin('ready'), plugin('ready')])).toEqual([
      { id: 'o/map.map', title: 'map', href: '/x/o/map/map', plugin: 'Map' },
      { id: 'o/map.other', title: 'Other', href: '/x/o/map/other', plugin: 'Map' },
    ]);
    expect(pluginNavItems([plugin('disabled')])).toEqual([]);
  });

  it('checks navbar.order and navbar.hidden; settings cannot be hidden', () => {
    expect(checkSettings('{ "navbar.order": ["o/map.map", "changes"], "navbar.hidden": ["papers"] }')).toEqual([]);
    expect(checkSettings('{ "navbar.hidden": ["settings"] }').some((p) => p.severity === 'error')).toBe(true);
    expect(resolveSettings({ user: { 'navbar.hidden': ['settings', 'papers', 'nope'] } })['navbar.hidden']).toEqual([
      'papers',
    ]);
  });
});
