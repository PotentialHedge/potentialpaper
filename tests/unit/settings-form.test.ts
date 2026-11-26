import { describe, expect, it } from 'vitest';
import { validateManifest } from '@/lib/plugins/manifest';
import { sanitizeSettingValue, type SettingSpec, settingsJsonSchema, settingTitle } from '@/lib/settings';
import { CATEGORIES, coreItems, itemKeys, matchesSearch, pluginItems } from '@/lib/settings/form';

describe('list and set settings', () => {
  const list: SettingSpec = { type: 'list', default: [], maxItems: 2, maxLength: 5 };
  const picked: SettingSpec = { type: 'list', default: [], values: ['a', 'b', 'c'] };
  const set: SettingSpec = { type: 'set', default: [], values: ['a', 'b', 'c'] };

  it('reads a list of different strings within its limits', () => {
    expect(sanitizeSettingValue(list, ['x', 'y'])).toEqual(['x', 'y']);
    expect(sanitizeSettingValue(list, ['x', 'y', 'z'])).toBeUndefined();
    expect(sanitizeSettingValue(list, ['x', 'x'])).toBeUndefined();
    expect(sanitizeSettingValue(list, ['toolong'])).toBeUndefined();
    expect(sanitizeSettingValue(list, [''])).toBeUndefined();
    expect(sanitizeSettingValue(list, 'x')).toBeUndefined();
  });

  it('keeps a picked list in its own order, from its values only', () => {
    expect(sanitizeSettingValue(picked, ['c', 'a'])).toEqual(['c', 'a']);
    expect(sanitizeSettingValue(picked, ['d'])).toBeUndefined();
  });

  it("reads a set in its values' order", () => {
    expect(sanitizeSettingValue(set, ['c', 'a'])).toEqual(['a', 'c']);
    expect(sanitizeSettingValue(set, ['d'])).toBeUndefined();
  });

  it('puts them in the JSON Schema as arrays', () => {
    const schema = settingsJsonSchema('https://x', [{ id: 'o/p', settings: { picked, set } }]) as {
      properties: Record<string, { type: string; uniqueItems: boolean; title: string }>;
    };
    expect(schema.properties['o/p.picked']).toMatchObject({ type: 'array', uniqueItems: true, title: 'Picked' });
    expect(schema.properties['o/p.set'].type).toBe('array');
  });
});

describe('the settings form', () => {
  it('spaces out a name with no title', () => {
    expect(settingTitle('showLegend', {})).toBe('Show legend');
    expect(settingTitle('show-legend', {})).toBe('Show legend');
    expect(settingTitle('x', { title: 'Given' })).toBe('Given');
  });

  it('puts every core setting it shows on a category, and none of the site-only ones', () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    const items = coreItems();
    expect(items.every((i) => ids.has(i.category))).toBe(true);
    expect(items.some((i) => i.key.startsWith('plugins'))).toBe(false);
    // A kind's panels are one control: the order, with a switch per panel for the hidden list.
    expect(items.some((i) => i.key === 'paper.panels.hidden')).toBe(false);
    const panels = items.find((i) => i.key === 'paper.panels.order')!;
    expect(panels.control).toMatchObject({
      kind: 'rank',
      toggleKey: 'paper.panels.hidden',
      placeKey: 'paper.panels.placement',
    });
    expect(itemKeys(panels)).toEqual(['paper.panels.order', 'paper.panels.hidden', 'paper.panels.placement']);
    expect(items.some((i) => i.key === 'paper.panels.placement')).toBe(false);
    expect(matchesSearch(panels, 'Paper pages', 'hidden')).toBe(true);
  });

  it('arranges the navbar as it does panels, with settings always shown', () => {
    const items = coreItems((list) => (list === 'navbar' ? [{ value: 'o/p.map', label: 'map (P)' }] : []));
    const nav = items.find((i) => i.key === 'navbar.order')!;
    expect(nav.category).toBe('navbar');
    expect(itemKeys(nav)).toEqual(['navbar.order', 'navbar.hidden']);
    expect(nav.control).toMatchObject({ kind: 'rank', toggleKey: 'navbar.hidden' });
    const choices = (nav.control as { choices: { value: string; locked?: boolean }[] }).choices;
    expect(choices.map((c) => c.value)).toEqual(['papers', 'changes', 'settings', 'o/p.map']);
    expect(choices.find((c) => c.value === 'settings')?.locked).toBe(true);
    expect(items.some((i) => i.key === 'navbar.hidden')).toBe(false);
  });

  it('draws "Not a reviewer at" as a box per venue under review, ticked for those listed', () => {
    const venue = { value: 'openreview:ICLR.cc/2027/Conference', label: 'ICLR 2027' };
    const item = coreItems(undefined, { 'paper.notReviewerAt': [venue] }).find((i) => i.key === 'paper.notReviewerAt')!;
    expect(item.category).toBe(coreItems().find((i) => i.key === 'paper.panels.order')!.category);
    expect(item.control).toEqual({ kind: 'checklist', choices: [venue], inverted: false });
  });

  it("draws a plugin's settings with the standard controls, in their order", () => {
    const items = pluginItems('o/p', {
      b: { type: 'enum', default: 'x', values: ['x', 'y'], display: 'radio', order: 2 },
      a: { type: 'list', default: [], order: 1 },
      c: { type: 'string', default: '', multiline: true },
    });
    expect(items.map((i) => i.key)).toEqual(['o/p.a', 'o/p.b', 'o/p.c']);
    expect(items.map((i) => i.control.kind)).toEqual(['list', 'select', 'text']);
    expect(items[1].control).toMatchObject({ display: 'radio' });
  });

  it('finds a setting by every word of a search', () => {
    const [item] = pluginItems('o/p', { mutedWords: { type: 'list', default: [], description: 'Hide comments.' } });
    expect(matchesSearch(item, 'Demo', 'muted hide')).toBe(true);
    expect(matchesSearch(item, 'Demo', 'demo')).toBe(true);
    expect(matchesSearch(item, 'Demo', 'muted show')).toBe(false);
  });
});

describe('manifest settings', () => {
  const manifest = (settings: unknown) => ({
    id: 'o/p',
    name: 'P',
    version: '1.0.0',
    apiVersion: 1,
    main: 'index.html',
    contributes: { panels: [{ id: 'p', title: 'P', kinds: ['paper'], slot: 'main' }], settings },
  });

  it('accepts the new types and fields', () => {
    const result = validateManifest(
      manifest({
        words: { type: 'list', default: ['a'], maxItems: 5, placeholder: 'A word', group: 'Filters', order: 1 },
        fields: { type: 'set', default: ['x'], values: ['x', 'y'], labels: ['X', 'Y'], title: 'Fields' },
        mode: { type: 'enum', default: 'a', values: ['a', 'b'], display: 'radio' },
        note: { type: 'string', default: '', multiline: true },
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings.filter((w) => w.includes('settings'))).toEqual([]);
  });

  it('refuses a default that does not fit, and labels that do not match', () => {
    const result = validateManifest(
      manifest({
        fields: { type: 'set', default: ['z'], values: ['x', 'y'], labels: ['X'] },
      }),
    );
    expect(result.errors.some((e) => e.startsWith('contributes.settings.fields.default'))).toBe(true);
    expect(result.errors.some((e) => e.startsWith('contributes.settings.fields.labels'))).toBe(true);
  });
});
