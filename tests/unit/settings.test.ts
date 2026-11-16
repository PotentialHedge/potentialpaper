import { describe, expect, it } from 'vitest';
import { arrangePanels } from '@/lib/panels';
import {
  checkSettings,
  formatProblem,
  parseSettings,
  resolveSettings,
  sanitizeSettingValue,
  setInSettings,
  settingsJsonSchema,
  splitQualified,
  type PluginSettings,
} from '@/lib/settings';

const STANDING: PluginSettings = {
  id: 'benedict-armstrong/score-standing',
  settings: {
    view: { type: 'enum', default: 'both', values: ['both', 'histogram', 'curve'] },
    field: { type: 'string', default: '' },
  },
};

describe('settings documents', () => {
  it('parses JSONC, comments and trailing commas included, and reads anything else as empty', () => {
    expect(parseSettings('// mine\n{ "paper.panels.hidden": ["abstract",], }')).toEqual({
      'paper.panels.hidden': ['abstract'],
    });
    expect(parseSettings('[1]')).toEqual({});
    expect(parseSettings('')).toEqual({});
    expect(parseSettings(null)).toEqual({});
  });

  it('resolves defaults ← site ← user, and a bad value reads as the layer below', () => {
    const site = { 'paper.panels.hidden': ['discussion'] };
    expect(resolveSettings({})['paper.panels.hidden']).toEqual([]);
    expect(resolveSettings({ site })['paper.panels.hidden']).toEqual(['discussion']);
    expect(resolveSettings({ site, user: { 'paper.panels.hidden': ['abstract'] } })['paper.panels.hidden']).toEqual([
      'abstract',
    ]);
    expect(resolveSettings({ site, user: { 'paper.panels.hidden': 'abstract' } })['paper.panels.hidden']).toEqual([
      'discussion',
    ]);
    // Leniently: a panel that no longer exists is dropped, the rest still counts.
    expect(resolveSettings({ user: { 'paper.panels.order': ['gone', 'discussion', 'discussion'] } })).toMatchObject({
      'paper.panels.order': ['discussion'],
    });
  });

  it("resolves an installed plugin's settings by its specs", () => {
    const values = resolveSettings({ user: { 'benedict-armstrong/score-standing.view': 'curve' } }, [STANDING]);
    expect(values['benedict-armstrong/score-standing.view']).toBe('curve');
    expect(values['benedict-armstrong/score-standing.field']).toBe('');
    const bad = resolveSettings({ user: { 'benedict-armstrong/score-standing.view': 'pie' } }, [STANDING]);
    expect(bad['benedict-armstrong/score-standing.view']).toBe('both');
  });

  it('reports every problem, each naming its key, and keeps unknown keys with a warning', () => {
    const text = `{
  // Two problems, a warning and a plugin not installed yet.
  "paper.panels.hidden": ["abstract", "nope"],
  "paper.panels.order": "discussion",
  "feed.sparkles": true,
  "someone/other.thing": 1,
  "benedict-armstrong/score-standing.view": "pie",
  "benedict-armstrong/score-standing.colour": "red"
}`;
    const problems = checkSettings(text, [STANDING]);
    expect(problems.map((p) => [p.severity, formatProblem(p)])).toEqual([
      ['error', expect.stringMatching(/^paper\.panels\.hidden: item 1: /)],
      ['error', expect.stringMatching(/^paper\.panels\.order: /)],
      ['warning', 'feed.sparkles: not a setting this site knows; kept'],
      ['warning', "someone/other.thing: for the plugin someone/other, which isn't installed; kept"],
      ['error', 'benedict-armstrong/score-standing.view: must be one of "both", "histogram", "curve"'],
      [
        'warning',
        'benedict-armstrong/score-standing.colour: benedict-armstrong/score-standing has no setting "colour"; kept',
      ],
    ]);
    expect(problems[0].line).toBe(3);
    expect(checkSettings('{ "paper.panels.hidden": ["abstract", "abstract"] }')[0].message).toMatch(/twice/);
  });

  it('reports syntax errors by line, and a top level that is not an object', () => {
    const [problem] = checkSettings('{\n  "a": 1\n  "b": 2\n}');
    expect(problem).toMatchObject({ severity: 'error', key: null, line: 3 });
    expect(formatProblem(problem)).toMatch(/^line 3: /);
    expect(checkSettings('[]')[0].message).toMatch(/JSON object/);
    expect(checkSettings('')).toEqual([]);
  });

  it('sets and removes one key, keeping comments and order', () => {
    const text = '{\n  "b": 1,\n  // keep me\n  "a": 2\n}\n';
    const set = setInSettings(text, 'paper.panels.hidden', ['abstract']);
    expect(set).toContain('// keep me');
    expect(parseSettings(set)).toEqual({ b: 1, a: 2, 'paper.panels.hidden': ['abstract'] });
    expect(Object.keys(parseSettings(set))).toEqual(['b', 'a', 'paper.panels.hidden']);
    const removed = setInSettings(set, 'b', undefined);
    expect(removed).toContain('// keep me');
    expect(parseSettings(removed)).toEqual({ a: 2, 'paper.panels.hidden': ['abstract'] });
    expect(parseSettings(setInSettings('', 'x', true))).toEqual({ x: true });
    // The last key takes the comma before it; a comment on its line goes with it, one on a line of its own stays.
    const last = setInSettings('// top\n{\n  "b": 1, // b\n  // a\n  "a": 2 // a too\n}\n', 'a', undefined);
    expect(last).toBe('// top\n{\n  "b": 1 // b\n  // a\n}\n');
    expect(setInSettings('{ "a": 1, "b": 2 }', 'a', undefined)).toBe('{ "b": 2 }');
  });

  it('makes a JSON Schema of the core keys and the plugins’ keys', () => {
    const schema = settingsJsonSchema('https://example.org', [STANDING]) as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties['paper.panels.hidden']).toMatchObject({
      type: 'array',
      items: { enum: expect.arrayContaining(['abstract', 'discussion']) },
      default: [],
    });
    expect(schema.properties['benedict-armstrong/score-standing.view']).toMatchObject({
      enum: ['both', 'histogram', 'curve'],
      default: 'both',
    });
  });

  it('checks plugin values as Presio does, and splits plugin keys on the last dot', () => {
    expect(sanitizeSettingValue({ type: 'number', default: 1, minimum: 0 }, -1)).toBeUndefined();
    expect(sanitizeSettingValue({ type: 'number', default: null }, null)).toBeNull();
    expect(sanitizeSettingValue({ type: 'string', default: '', maxLength: 2 }, 'abc')).toBeUndefined();
    expect(splitQualified('benedict-armstrong/score-standing.view')).toEqual({
      pluginId: 'benedict-armstrong/score-standing',
      name: 'view',
    });
    expect(splitQualified('paper.panels.hidden')).toBeNull();
  });
});

describe('arranging panels', () => {
  const ids = ['community', 'versions', 'submissions', 'discussion'];
  it('leaves hidden ones out and puts ordered ones first', () => {
    expect(arrangePanels(ids, [], [])).toEqual(ids);
    expect(arrangePanels(ids, ['versions'], ['discussion'])).toEqual(['discussion', 'community', 'submissions']);
    // An id from another slot changes nothing here.
    expect(arrangePanels(ids, [], ['abstract', 'submissions'])).toEqual([
      'submissions',
      'community',
      'versions',
      'discussion',
    ]);
  });
});
