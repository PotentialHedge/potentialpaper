import { describe, expect, it } from 'vitest';
import type { InstalledPlugin } from '@/lib/plugins/installed';
import { validateManifest } from '@/lib/plugins/manifest';
import { arrangeActions, pluginActions } from '@/lib/page-actions';
import { checkSettings, resolveSettings } from '@/lib/settings';
import { renderSourceText } from '@/server/comments/render';

const manifest = (actions: unknown[]) =>
  validateManifest({
    id: 'o/tr',
    name: 'Translate',
    version: '1.0.0',
    apiVersion: 1,
    main: 'index.html',
    contributes: { actions },
  });

describe('page actions', () => {
  it('puts the first four shown in the bar and the rest in the menu', () => {
    const ids = ['cite', 'edit', 'follow', 'share', 'history', 'agents'];
    expect(arrangeActions(ids, [], [])).toEqual({
      bar: ['cite', 'edit', 'follow', 'share'],
      menu: ['history', 'agents'],
    });
    expect(arrangeActions(ids, ['follow'], ['history'])).toEqual({
      bar: ['history', 'cite', 'edit', 'share'],
      menu: ['agents'],
    });
    expect(arrangeActions(['edit', 'share', 'history'], [], [])).toEqual({
      bar: ['edit', 'share', 'history'],
      menu: [],
    });
  });

  it("takes a plugin's actions for the page's kind whose when holds", () => {
    const report = manifest([
      { id: 'translate', title: 'translate', kinds: ['paper'] },
      { id: 'scores', title: 'scores', kinds: ['paper', 'venue'], when: 'page.hasScores' },
    ]);
    expect(report.errors).toEqual([]);
    const plugin = (status: InstalledPlugin['status']) =>
      ({ status, plugin: { id: 'o/tr', manifest: report.manifest! } }) as InstalledPlugin;
    const ids = (kind: 'paper' | 'venue', hasScores: boolean) =>
      pluginActions([plugin('ready'), plugin('ready')], { kind, context: { 'page.hasScores': hasScores } }).map(
        (a) => a.id,
      );
    expect(ids('paper', false)).toEqual(['o/tr.translate']);
    expect(ids('paper', true)).toEqual(['o/tr.translate', 'o/tr.scores']);
    expect(ids('venue', true)).toEqual(['o/tr.scores']);
    expect(pluginActions([plugin('disabled')])).toEqual([]);
  });

  it('checks an action: unique ids, a when that parses', () => {
    expect(
      manifest([
        { id: 'a', title: 'a', kinds: ['paper'] },
        { id: 'a', title: 'b', kinds: ['paper'] },
      ]).errors,
    ).toEqual(['contributes.actions[1].id: a second action "a"']);
    expect(manifest([{ id: 'a', title: 'a', kinds: ['paper'], when: '&&' }]).errors).toHaveLength(1);
  });

  it('checks actions.order and actions.hidden', () => {
    expect(checkSettings('{ "actions.order": ["o/tr.translate", "share"], "actions.hidden": ["cite"] }')).toEqual([]);
    expect(checkSettings('{ "actions.hidden": ["nope"] }').some((p) => p.severity === 'error')).toBe(true);
    expect(resolveSettings({ user: { 'actions.order': ['history', 'nope', 'history'] } })['actions.order']).toEqual([
      'history',
    ]);
  });
});

describe('abstracts', () => {
  it('renders Markdown and TeX', () => {
    const html = renderSourceText('Up to $4\\times$ faster, **agent repackaging**.\n\nA second paragraph.');
    expect(html).toContain('katex');
    expect(html).toContain('<strong>agent repackaging</strong>');
    expect(html.match(/<p>/g)).toHaveLength(2);
    expect(renderSourceText('<script>x</script>')).not.toContain('<script>');
  });
});
