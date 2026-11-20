import { describe, expect, it } from 'vitest';
import { pluginNavItems } from '@/lib/nav';
import { pluginPanelChoices } from '@/lib/plugins/installed';
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

  it('sets a panel under each submission as a sub-item of the Submissions panel', () => {
    const { manifest } = validateManifest({
      id: 'o/s',
      name: 'S',
      version: '1.0.0',
      apiVersion: 1,
      main: 'index.html',
      contributes: {
        panels: [
          { id: 'standing', title: 'Standing', kinds: ['paper', 'venue'], slot: { paper: 'submission', '*': 'main' } },
        ],
      },
    });
    const plugins = [{ plugin: { manifest, id: 'o/s' } }] as unknown as InstalledPlugin[];
    const [choice] = pluginPanelChoices(plugins, 'paper');
    expect(choice).toMatchObject({
      value: 'o/s.standing',
      label: 'Standing (S)',
      group: 'Below both',
      parent: 'submissions',
    });
    // Movable: its own place first, then every other a reader may choose on a paper, never the author section.
    expect(choice.places!.map((p) => p.value)).toEqual(['submission', 'main', 'aside', 'tab', 'body', 'community']);
    expect(choice.places![1]).toEqual({ value: 'main', label: 'Main column', group: 'Main column' });
    expect(pluginPanelChoices(plugins, 'venue')[0].parent).toBeUndefined();
    expect(pluginPanelChoices(plugins, 'venue')[0].places!.map((p) => p.value)).toEqual([
      'main',
      'aside',
      'tab',
      'body',
    ]);
  });
});
