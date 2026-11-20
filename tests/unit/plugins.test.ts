import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, dispatch, type HostServices } from '@/lib/plugins/host';
import {
  consentMissing,
  installedEntries,
  isBlocked,
  missingConsent,
  runningPermissions,
} from '@/lib/plugins/installed';
import { parseAuthorPlugins } from '@/lib/plugins/author-plugins';
import {
  kindSlot,
  manifestJsonSchema,
  panelPlace,
  panelSlot,
  placeOfSlot,
  PLUGIN_PANEL_ID_RE,
  validateManifest,
} from '@/lib/plugins/manifest';
import { BOOT_MESSAGE, type FrameContext, HELLO_MESSAGE } from '@/lib/plugins/protocol';
import { parsePluginSource, sourceKey } from '@/lib/plugins/sources';
import { evalWhen, pageWhenContext, parseWhen, whenHolds, whenProblem } from '@/lib/plugins/when';
import { checkSettings, parseSettings, resolveSettings, setInSettings } from '@/lib/settings';
import { pluginCsp } from '@/server/plugins/serve';

const HELLO = JSON.parse(readFileSync('examples/plugins/hello/potentialpaper-plugin.json', 'utf8'));

describe('plugin sources', () => {
  it('reads github:, owner/repo and GitHub links, and keys them without the ref', () => {
    expect(parsePluginSource('github:Benedict-Armstrong/potentialpaper-score-standing@v0.1.0')).toEqual({
      kind: 'github',
      owner: 'Benedict-Armstrong',
      repo: 'potentialpaper-score-standing',
      path: '',
      ref: 'v0.1.0',
    });
    const folder = parsePluginSource('github:alice/kit/plugins/poll@feature/x')!;
    expect(folder).toMatchObject({ path: 'plugins/poll', ref: 'feature/x' });
    expect(sourceKey(folder)).toBe('github:alice/kit/plugins/poll');
    expect(sourceKey(parsePluginSource('alice/Poll@v1')!)).toBe('github:alice/poll');
    expect(parsePluginSource('https://github.com/alice/poll/tree/v2/dist')).toMatchObject({ ref: 'v2', path: 'dist' });
    expect(parsePluginSource('http://localhost:5173/potentialpaper-plugin.json')).toEqual({
      kind: 'dev',
      url: 'http://localhost:5173/',
    });
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'github:alice',
      'github:alice/x/../y',
      'https://example.org/x',
      'http://example.org/',
      'ftp://x/y',
    ]) {
      expect(parsePluginSource(bad)).toBeNull();
    }
  });
});

describe('when conditions', () => {
  const venue = { 'page.kind': 'venue', signedIn: true, 'page.hasScores': false };
  it('parses and evaluates VS Code-style clauses', () => {
    expect(whenHolds('page.kind == venue && signedIn', venue)).toBe(true);
    expect(whenHolds('page.hasScores || !signedIn', venue)).toBe(false);
    expect(whenHolds('(page.hasScores || signedIn) && page.kind != "topic"', venue)).toBe(true);
    // A key the page's kind doesn't offer reads as unset.
    expect(evalWhen(parseWhen('viewer.isOwner'), venue)).toBe(false);
    expect(whenHolds(undefined, venue)).toBe(true);
    expect(whenHolds('page.kind ==', venue)).toBe(false);
  });

  it('names what is wrong', () => {
    expect(whenProblem('page.hasScores && ')).toMatch(/ends too soon/);
    expect(whenProblem('page.colour')).toMatch(/no page offers "page.colour"/);
    expect(whenProblem('(signedIn')).toMatch(/expected "\)"/);
  });

  it("offers each kind's own keys only", () => {
    const topic = pageWhenContext('topic', { hasScores: true, signedIn: false, isOwner: false });
    expect(topic).not.toHaveProperty('page.hasScores');
    expect(pageWhenContext('paper', { hasScores: true, signedIn: true, isOwner: true })).toMatchObject({
      'page.kind': 'paper',
      'page.hasScores': true,
      'viewer.isOwner': true,
    });
  });
});

describe('plugin manifests', () => {
  it('accepts the example plugin', () => {
    const report = validateManifest(HELLO);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.manifest).toMatchObject({ id: 'potentialhedge/hello', network: [], permissions: ['page.read'] });
    const panel = report.manifest!.contributes.panels[0];
    expect(panelSlot(panel, 'paper')).toBe('aside');
    expect(panelSlot(panel, 'venue')).toBe('main');
  });

  it('reports every problem in one pass, each naming its field', () => {
    const report = validateManifest({
      id: 'Alice/Hello',
      name: '',
      version: 'v1.0',
      apiVersion: 1,
      main: '../index.html',
      permissions: ['page.read', 'everything'],
      network: ['http://api.example.org', 'https://api.example.org/v1'],
      contributes: {
        panels: [
          { id: 'main', title: 'A', kinds: ['paper', 'venue'], slot: { paper: 'aside' }, when: 'page.colour' },
          { id: 'main', title: 'B', kinds: ['topic'], slot: 'tab' },
        ],
        settings: { view: { type: 'enum', values: ['a', 'b'], default: 'c' } },
      },
      surprise: true,
    });
    expect(report.manifest).toBeNull();
    const errors = report.errors.join('\n');
    for (const field of ['id:', 'name:', 'version:', 'main:', 'permissions[1]:', 'network[0]:', 'network[1]:']) {
      expect(errors).toContain(field);
    }
    expect(report.warnings).toContain('surprise: not a field this site knows; ignored');
  });

  it('checks what the schema cannot, once the shape is right', () => {
    const report = validateManifest({
      ...HELLO,
      contributes: {
        panels: [
          { id: 'one', title: 'A', kinds: ['paper', 'venue'], slot: { paper: 'aside' }, when: 'page.colour' },
          { id: 'one', title: 'B', kinds: ['topic'], slot: 'tab', when: 'page.hasScores', extra: 1 },
        ],
        settings: { view: { type: 'enum', values: ['a', 'b'], default: 'c' } },
      },
    });
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'contributes.panels[1].id: a second panel "one"',
        'contributes.panels[0].slot: says nothing for venue pages; add "venue" or "*"',
        expect.stringMatching(/^contributes\.panels\[0\]\.when: no page offers "page\.colour"/),
        'contributes.settings.view.default: "c" doesn\'t fit the setting\'s own type',
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        'contributes.panels[1].extra: not a field this site knows; ignored',
        "contributes.panels[1].when: topic pages don't offer page.hasScores, which read as false there",
      ]),
    );
  });

  it('puts a panel under each submission on a paper only', () => {
    const panel = (slot: unknown) => ({ id: 'standing', title: 'A', kinds: ['paper', 'venue'], slot });
    const ok = validateManifest({ ...HELLO, contributes: { panels: [panel({ paper: 'submission', '*': 'main' })] } });
    expect(ok.errors).toEqual([]);
    expect(panelSlot(ok.manifest!.contributes.panels[0], 'paper')).toBe('submission');
    expect(kindSlot('paper', 'submission')).toBe('paper.submission');
    expect(validateManifest({ ...HELLO, contributes: { panels: [panel('submission')] } }).errors).toEqual([
      'contributes.panels[0].slot: venue pages have no "submission" slot',
    ]);
  });

  it('puts a panel in the community section on a paper only', () => {
    const panel = (slot: unknown) => ({ id: 'minimap', title: 'A', kinds: ['paper', 'venue'], slot });
    const ok = validateManifest({ ...HELLO, contributes: { panels: [panel({ paper: 'community', '*': 'main' })] } });
    expect(ok.errors).toEqual([]);
    expect(kindSlot('paper', 'community')).toBe('paper.community');
    expect(validateManifest({ ...HELLO, contributes: { panels: [panel('community')] } }).errors).toEqual([
      'contributes.panels[0].slot: venue pages have no "community" slot',
    ]);
  });

  it("moves a movable panel where the reader's placement says, but never into or out of the author section", () => {
    const panel = (slot: unknown, movable?: boolean) => {
      const { manifest, errors } = validateManifest({
        ...HELLO,
        contributes: {
          panels: [{ id: 'p', title: 'P', kinds: ['paper', 'venue'], slot, ...(movable === false && { movable }) }],
        },
      });
      expect(errors).toEqual([]);
      return manifest!.contributes.panels[0];
    };
    const map = panel({ paper: 'community', '*': 'tab' });
    expect(map.movable).toBe(true);
    expect(panelPlace(map, 'paper', undefined)).toBe('community');
    expect(panelPlace(map, 'paper', 'main')).toBe('main');
    expect(panelPlace(map, 'paper', 'body')).toBe('body');
    expect(panelPlace(map, 'paper', 'author')).toBe('community');
    expect(panelPlace(map, 'venue', 'community')).toBe('tab');
    expect(panelPlace(panel({ paper: 'community', '*': 'tab' }, false), 'paper', 'main')).toBe('community');
    const own = { ...HELLO, contributes: { panels: [{ id: 'p', title: 'P', kinds: ['paper'], slot: 'author' }] } };
    expect(panelPlace(validateManifest(own).manifest!.contributes.panels[0], 'paper', 'main')).toBe('author');
    expect(
      validateManifest({ ...own, contributes: { panels: [{ ...own.contributes.panels[0], kinds: ['venue'] }] } })
        .errors,
    ).toEqual(['contributes.panels[0].slot: venue pages have no "author" slot']);
    expect(placeOfSlot('paper.tabs')).toBe('tab');
    expect(placeOfSlot('paper.community')).toBe('community');
  });

  it("reads a paper's owners/plugins.json", () => {
    expect(parseAuthorPlugins('{ "panels": [{ "panel": "o/map.minimap", "settings": { "set": "o/s" } }] }')).toEqual({
      panels: [{ panel: 'o/map.minimap', settings: { set: 'o/s' } }],
    });
    expect('problem' in parseAuthorPlugins('{ "panels": [{ "panel": "minimap" }] }')).toBe(true);
    expect('problem' in parseAuthorPlugins('{ "panels": [{ "panel": "o/m.a" }, { "panel": "o/m.a" }] }')).toBe(true);
    expect('problem' in parseAuthorPlugins('not json')).toBe(true);
  });

  it('refuses a manifest for a newer API, saying so', () => {
    expect(validateManifest({ ...HELLO, apiVersion: 2 }).errors).toEqual([
      'apiVersion: the plugin is for API version 2, and this site runs 1',
    ]);
  });

  it('has a JSON Schema', () => {
    const schema = manifestJsonSchema('https://example.org') as { $id: string; properties: Record<string, unknown> };
    expect(schema.$id).toBe('https://example.org/schemas/plugin-manifest.json');
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['id', 'permissions', 'network', 'contributes']),
    );
  });

  it("names a plugin's panels as <plugin id>.<panel id>", () => {
    expect(PLUGIN_PANEL_ID_RE.test('benedict-armstrong/score-standing.standing')).toBe(true);
    expect(PLUGIN_PANEL_ID_RE.test('abstract')).toBe(false);
  });
});

describe('the plugins settings', () => {
  it('installs the site defaults, which a reader can turn off or re-pin, beside their own', () => {
    const site = parseSettings(`{ "plugins.default": ["github:site/one@v1", "github:site/two"] }`);
    const user = parseSettings(`{
      "plugins": {
        "github:Site/Two": { "enabled": false },
        "github:site/one": { "ref": "v2" },
        "github:me/mine@main": {},
        "not a source": {}
      },
      "plugins.default": ["github:me/ignored"]
    }`);
    expect(installedEntries(resolveSettings({ site, user }))).toEqual([
      { source: 'github:site/one', ref: 'v2', enabled: true, from: 'user' },
      { source: 'github:site/two', ref: null, enabled: false, from: 'site' },
      { source: 'github:me/mine', ref: 'main', enabled: true, from: 'user' },
    ]);
  });

  it("warns about the site's keys in a user's file, and checks the plugins key", () => {
    const problems = checkSettings(`{ "plugins.blocked": ["x/y"], "plugins": { "nope": {} } }`);
    expect(problems).toEqual([
      expect.objectContaining({ severity: 'warning', key: 'plugins.blocked' }),
      expect.objectContaining({ severity: 'error', key: 'plugins' }),
    ]);
    expect(checkSettings(`{ "plugins.blocked": ["x/y", "x/z@${'a'.repeat(40)}"] }`, [], 'site')).toEqual([]);
  });

  it("accepts plugins' panel ids in a kind's panel settings", () => {
    expect(checkSettings(`{ "venue.panels.hidden": ["papers", "alice/stats.chart"] }`)).toEqual([]);
    expect(
      resolveSettings({ user: parseSettings(`{ "venue.panels.order": ["alice/stats.chart", "gone"] }`) }),
    ).toMatchObject({
      'venue.panels.order': ['alice/stats.chart'],
    });
  });

  it('blocks by id or by id at a commit, and asks again for anything new', () => {
    expect(isBlocked(['a/b'], 'a/b', 'c'.repeat(40))).toBe(true);
    expect(isBlocked([`a/b@${'c'.repeat(40)}`], 'a/b', 'd'.repeat(40))).toBe(false);
    const manifest = { permissions: ['page.read', 'scope.read'] as const, network: ['https://api.example.org'] };
    expect(
      missingConsent(
        { ...manifest, permissions: [...manifest.permissions] },
        { permissions: ['page.read'], network: [] },
      ),
    ).toEqual({
      permissions: ['scope.read'],
      network: ['https://api.example.org'],
    });
  });

  it('sets one entry of plugins and keeps the rest of the file', () => {
    const text = '{\n  // mine\n  "plugins": {\n    "github:a/b": {}\n  }\n}\n';
    const next = setInSettings(text, ['plugins', 'github:c/d'], { enabled: true });
    expect(next).toContain('// mine');
    expect(parseSettings(next).plugins).toEqual({ 'github:a/b': {}, 'github:c/d': { enabled: true } });
  });
});

describe("a plugin's CSP", () => {
  it('lets it reach itself, the SDK and its own backend, and only the site frame it', () => {
    const csp = pluginCsp(['https://api.example.org']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' https://api.example.org");
    expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval' .*https:\/\/ppusercontent\.com\/sdk\//);
    expect(csp).toMatch(/frame-ancestors http:\/\/test\.local/);
  });
});

function services(
  overrides: Partial<HostServices> = {},
): HostServices & { calls: string[]; stored: Record<string, unknown> } {
  const calls: string[] = [];
  const stored: Record<string, unknown> = {};
  let settings: Record<string, unknown> = { greeting: 'Hello', showScopes: true };
  return {
    calls,
    stored,
    context: () => CONTEXT,
    permissions: ['page.read'],
    settingSpecs: validateManifest(HELLO).manifest!.contributes.settings,
    settings: () => settings,
    setSetting: async (name, value) => {
      settings = { ...settings, [name]: value };
    },
    storageGet: async () => stored,
    storageSet: async (key, value) => {
      if (value === null) delete stored[key];
      else stored[key] = value;
    },
    api: async (path) => {
      calls.push(path);
      return { path };
    },
    apiLines: async (path) => {
      calls.push(path);
      return { rows: [{ path }], next: null };
    },
    identityToken: async () => {
      calls.push('identity');
      return {
        token: 'h.p.s',
        expiresAt: '2026-11-17T12:05:00.000Z',
        audience: 'potentialhedge/hello',
        issuer: 'http://test.local',
        subject: 'p_x',
        handle: 'ada',
        jwksUrl: 'http://test.local/.well-known/jwks.json',
      };
    },
    setHeight: (h) => calls.push(`height ${h}`),
    openUrl: (url) => calls.push(`open ${url}`),
    setPath: (path) => calls.push(`path ${path.join('/')}`),
    ...overrides,
  };
}

const CONTEXT: FrameContext = {
  plugin: { id: 'potentialhedge/hello', name: 'Hello', version: '1.0.0', sha: 'a'.repeat(40), dev: false },
  surface: { type: 'panel', panel: 'hello', slot: 'venue.main', place: 'main', size: { width: 600, height: 120 } },
  page: {
    kind: 'venue',
    identifier: 'venue:iclr/2027',
    address: '/v/iclr/2027',
    url: 'http://test.local/v/iclr/2027',
    name: 'ICLR 2027',
  },
  scopes: [],
  viewer: { signedIn: true, isOwner: false },
  theme: { mode: 'light', tokens: { ink: '#1d1d1d' } },
  settings: { greeting: 'Hello', showScopes: true },
  site: 'http://test.local',
  methods: [],
};

const call = (method: string, params?: unknown) => ({ v: 1 as const, kind: 'call' as const, id: 1, method, params });

describe('the host side of the RPC', () => {
  it('checks the method, the permission and the params', async () => {
    const s = services();
    expect(await dispatch(s, call('page.drop'))).toMatchObject({ error: { code: 'MethodNotFound' } });
    expect(await dispatch(s, call('page.members', { identifier: 'venue:iclr/2027' }))).toMatchObject({
      error: { code: 'PermissionDenied', message: expect.stringContaining('"scope.read"') },
    });
    expect(await dispatch(s, call('page.read', { identifier: 'not one' }))).toMatchObject({
      error: { code: 'InvalidParams' },
    });
    expect(await dispatch(s, call('page.read', { identifier: 'venue:iclr/2027' }))).toMatchObject({
      result: { path: '/pages/venue%3Aiclr%2F2027/files' },
    });
    expect(await dispatch(s, call('ui.openUrl', { url: 'javascript:alert(1)' }))).toMatchObject({
      error: { code: 'InvalidParams' },
    });
  });

  it("sets only the plugin's own settings, to values of their type", async () => {
    const s = services();
    expect(await dispatch(s, call('settings.set', { name: 'colour', value: 'red' }))).toMatchObject({
      error: { code: 'InvalidParams', message: 'the plugin declares no setting "colour"' },
    });
    expect(await dispatch(s, call('settings.set', { name: 'showScopes', value: 'yes' }))).toMatchObject({
      error: { code: 'InvalidParams' },
    });
    await dispatch(s, call('settings.set', { name: 'greeting', value: 'Hi' }));
    expect(await dispatch(s, call('settings.get'))).toMatchObject({ result: { greeting: 'Hi' } });
  });
});

/** A window for the SDK to run in: a parent to say hello to, and nothing of a real DOM it doesn't need. */
function sdkWindow(globals: Record<string, unknown> = {}) {
  const listeners: ((event: unknown) => void)[] = [];
  const toParent: unknown[] = [];
  const parent = { postMessage: (message: unknown) => toParent.push(message) };
  const style = new Map<string, string>();
  const win: Record<string, unknown> = {
    parent,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === 'message') listeners.push(fn);
    },
    scrollY: 0,
  };
  const document = {
    body: null,
    documentElement: { style: { setProperty: (k: string, v: string) => style.set(k, v) }, setAttribute() {} },
  };
  runInNewContext(readFileSync('public/sdk/v1/pp.js', 'utf8'), {
    window: win,
    document,
    console,
    Promise,
    Map,
    Object,
    String,
    Error,
    JSON,
    Math,
    ...globals,
  });
  return { win, listeners, toParent, parent, style };
}

const open: MessagePort[] = [];
afterEach(() => {
  for (const port of open.splice(0)) port.close();
});

describe('the SDK, against the host', () => {
  it('says hello, boots on the port it is given, and calls the host', async () => {
    const { win, listeners, toParent, parent, style } = sdkWindow();
    expect(toParent).toEqual([{ type: HELLO_MESSAGE, protocol: 1 }]);
    const s = services();
    const channel = new MessageChannel();
    open.push(channel.port1, channel.port2);
    const connection = connect(channel.port1, s);
    for (const listener of listeners) {
      listener({ source: parent, data: { type: BOOT_MESSAGE, protocol: 1, context: CONTEXT }, ports: [channel.port2] });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK as the page sees it
    const pp = win.pp as any;
    const context = await pp.ready;
    expect(context.page.identifier).toBe('venue:iclr/2027');
    expect(style.get('--pp-ink')).toBe('#1d1d1d');
    expect(pp.supports('page.read')).toBe(false);

    expect(await pp.settings.get()).toEqual({ greeting: 'Hello', showScopes: true });
    await pp.storage.set('visits', 3);
    expect(await pp.storage.get('visits')).toBe(3);
    expect(await pp.page.read()).toEqual({ path: '/pages/venue%3Aiclr%2F2027/files' });
    await expect(pp.page.members()).rejects.toMatchObject({ name: 'PluginError', code: 'PermissionDenied' });

    // Events and calls the other way.
    const changes: unknown[] = [];
    pp.settings.onChange((next: unknown) => changes.push(next));
    connection.emit('settings.change', { greeting: 'Hi', showScopes: false });
    pp.commands.register('reset', () => 'done');
    expect(await connection.call('commands.run', { command: 'reset' })).toBe('done');
    expect(changes).toEqual([{ greeting: 'Hi', showScopes: false }]);
    expect(pp.context.settings).toEqual({ greeting: 'Hi', showScopes: false });
    connection.close();
  });
});

describe('data for plugins over the RPC (scope.scores, scope.papers)', () => {
  it('asks the score routes, by scope, venue and field, behind scope.read', async () => {
    const venue = 'openreview:ICLR.cc/2027/Conference';
    const s = services({
      permissions: ['scope.read'],
      api: async (path) => {
        s.calls.push(path);
        return path.endsWith('/scores')
          ? { scores: [{ venue: { id: venue } }, { venue: { id: 'openreview:other' } }] }
          : { path };
      },
    });
    expect(await dispatch(services(), call('scope.scores', { identifier: 'venue:iclr/2027' }))).toMatchObject({
      error: { code: 'PermissionDenied' },
    });
    expect(await dispatch(s, call('scope.scores', { identifier: 'venue:iclr/2027' }))).toMatchObject({
      result: { scores: [{}, {}] },
    });
    expect(await dispatch(s, call('scope.scores', { identifier: 'venue:iclr/2027', venue }))).toMatchObject({
      result: { scores: [{ venue: { id: venue } }] },
    });
    expect(
      await dispatch(s, call('scope.scores', { identifier: 'venue:iclr/2027', venue, field: 'rating' })),
    ).toMatchObject({
      result: { path: '/pages/venue%3Aiclr%2F2027/scores/openreview%3AICLR.cc%2F2027%2FConference/rating' },
    });
    expect(await dispatch(s, call('scope.scores', { identifier: 'venue:iclr/2027', field: 'rating' }))).toMatchObject({
      error: { code: 'InvalidParams', message: expect.stringContaining('venue') },
    });
    // An org's own submissions by name, on one field only.
    expect(
      await dispatch(s, call('scope.scores', { identifier: 'org:eth', venue, field: 'rating', marks: true })),
    ).toMatchObject({
      result: { path: '/pages/org%3Aeth/scores/openreview%3AICLR.cc%2F2027%2FConference/rating?marks=true' },
    });
    expect(await dispatch(s, call('scope.scores', { identifier: 'org:eth', venue, marks: true }))).toMatchObject({
      error: { code: 'InvalidParams', message: expect.stringContaining('marks') },
    });
  });

  it('reads papers in chunks: the SDK follows the cursor to the end', async () => {
    const { win, listeners, parent } = sdkWindow();
    const chunks = new Map<string | null, { rows: unknown[]; next: string | null }>([
      [null, { rows: [{ title: 'A' }, { title: 'B' }], next: '00000000-0000-4000-8000-000000000001' }],
      ['00000000-0000-4000-8000-000000000001', { rows: [{ title: 'C' }], next: null }],
    ]);
    const s = services({
      permissions: ['scope.read'],
      apiLines: async (path) => {
        s.calls.push(path);
        return chunks.get(new URL(path, 'http://x').searchParams.get('after'))!;
      },
    });
    const channel = new MessageChannel();
    open.push(channel.port1, channel.port2);
    const connection = connect(channel.port1, s);
    for (const listener of listeners) {
      listener({ source: parent, data: { type: BOOT_MESSAGE, protocol: 1, context: CONTEXT }, ports: [channel.port2] });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK as the page sees it
    const pp = win.pp as any;
    await pp.ready;
    expect(
      (await pp.scope.papers(undefined, { fields: ['scores'], chunkSize: 2 })).map((r: { title: string }) => r.title),
    ).toEqual(['A', 'B', 'C']);
    expect(s.calls).toEqual([
      '/pages/venue%3Aiclr%2F2027/papers?limit=2&fields=scores',
      '/pages/venue%3Aiclr%2F2027/papers?limit=2&fields=scores&after=00000000-0000-4000-8000-000000000001',
    ]);
    const seen: unknown[][] = [];
    expect(await pp.scope.papers('venue:iclr/2027', { onChunk: (rows: unknown[]) => seen.push(rows) })).toEqual([]);
    expect(seen.map((rows) => rows.length)).toEqual([2, 1]);
    await expect(pp.scope.papers('venue:iclr/2027', { fields: ['votes'] })).rejects.toMatchObject({
      code: 'InvalidParams',
    });
    connection.close();
  });
});

describe('plugins with their own backend (identity, bot)', () => {
  it('accepts identity and a bot in the manifest, and warns when there is no backend to send a token to', () => {
    const report = validateManifest({
      ...HELLO,
      permissions: ['identity'],
      network: ['https://api.example.org'],
      bot: 'hello-bot',
    });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.manifest).toMatchObject({ permissions: ['identity'], bot: 'hello-bot' });
    expect(validateManifest({ ...HELLO, permissions: ['identity'] }).warnings).toEqual([
      'permissions: "identity" gives a token for your own backend, and "network" names none to send it to',
    ]);
    expect(validateManifest({ ...HELLO, bot: '@Hello Bot' }).errors).toEqual([expect.stringMatching(/^bot: /)]);
  });

  it('asks the reader for identity even for a site default, which runs without it until then', () => {
    const manifest = {
      permissions: ['page.read', 'identity'] as ('page.read' | 'identity')[],
      network: ['https://a.example.org'],
    };
    expect(consentMissing('site', manifest, null)).toEqual({ permissions: ['identity'], network: [] });
    expect(consentMissing('site', manifest, { permissions: ['identity'], network: [] })).toEqual({
      permissions: [],
      network: [],
    });
    expect(consentMissing('user', manifest, null)).toEqual({
      permissions: ['page.read', 'identity'],
      network: ['https://a.example.org'],
    });
    const site = { from: 'site' as const, missing: consentMissing('site', manifest, null), plugin: { manifest } };
    expect(runningPermissions(site)).toEqual(['page.read']);
    expect(runningPermissions({ ...site, from: 'dev' })).toEqual(['page.read', 'identity']);
  });

  it('gives a token only with identity, and the SDK sends it to the backend', async () => {
    expect(await dispatch(services(), call('identity.token'))).toMatchObject({
      error: { code: 'PermissionDenied', message: expect.stringContaining('"identity"') },
    });
    const s = services({ permissions: ['identity'] });
    expect(await dispatch(s, call('identity.token'))).toMatchObject({ result: { token: 'h.p.s', handle: 'ada' } });

    const sent: { url: string; auth: string | null; method: string }[] = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      sent.push({ url, auth: new Headers(init.headers).get('authorization'), method: init.method ?? 'GET' });
      return new Response('{}');
    };
    const { win, listeners, parent } = sdkWindow({ fetch: fakeFetch, Headers });
    const channel = new MessageChannel();
    open.push(channel.port1, channel.port2);
    const connection = connect(channel.port1, s);
    for (const listener of listeners) {
      listener({ source: parent, data: { type: BOOT_MESSAGE, protocol: 1, context: CONTEXT }, ports: [channel.port2] });
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK as the page sees it
    const pp = win.pp as any;
    await pp.ready;
    expect((await pp.identity.token()).audience).toBe('potentialhedge/hello');
    await pp.identity.fetch('https://api.example.org/notes', { method: 'POST', headers: { 'X-A': '1' } });
    expect(sent).toEqual([{ url: 'https://api.example.org/notes', auth: 'Bearer h.p.s', method: 'POST' }]);
    connection.close();
  });
});
