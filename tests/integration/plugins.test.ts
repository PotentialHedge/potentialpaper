import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/db';
import { accounts } from '@/db/schema';
import { pluginBaseUrl } from '@/lib/plugins/origin';
import { encodeReviewFile, formsFilePath, noteFilePath, submissionFilePath, type NoteFile } from '@/lib/review-files';
import { ensureBot, grantBot, OPENREVIEW_BOT } from '@/server/bots';
import { CONSUMERS } from '@/server/consumers';
import { runConsumer } from '@/server/consumers/run';
import { commitPage, createPage } from '@/server/pages/commit';
import { savePaper } from '@/server/papers';
import { servePlugin } from '@/server/plugins/serve';
import { pinPlugin, pluginHostLabel, storePluginFiles } from '@/server/plugins/snapshot';
import { forgetTags } from '@/server/plugins/tags';
import { recomputeDueScopes } from '@/server/scope-stats';
import { saveSiteSettings } from '@/server/settings';
import { mintToken } from '@/server/tokens';
import { api, closePool, resetDatabase, signUp } from './helpers';

/**
 * The plugin host's server side (`handoffs/plugins.md` Phase 2): installing a plugin from GitHub pinned to a commit,
 * serving it from its own origin, consent, the site's defaults and kill switch, storage, and the page routes the RPC
 * reads. The example plugin, `examples/plugins/hello/`, is the plugin.
 */

const HELLO_DIR = 'examples/plugins/hello';
const OWNER = 'potentialhedge';
const REPO = 'potentialpaper';
const FOLDER = 'examples/plugins/hello';
const SOURCE = `github:${OWNER}/${REPO}/${FOLDER}`;
const V1 = '1'.repeat(40);
const V2 = '2'.repeat(40);

function helloFiles(): Record<string, string> {
  return Object.fromEntries(readdirSync(HELLO_DIR).map((name) => [name, readFileSync(join(HELLO_DIR, name), 'utf8')]));
}

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, '0') + line;
}

/** A tarball of the repo at a commit, as codeload sends it: everything under one folder. */
function tarball(files: Record<string, string>, commit: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-repo-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, `${OWNER}-${REPO}-${commit.slice(0, 7)}`, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return gzipSync(
      execFileSync('tar', ['-cf', '-', '-C', dir, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** GitHub as plugins see it: a tag per commit, and codeload's tarballs. */
function fakeGitHub(commits: Record<string, Record<string, string>>, tags: Record<string, string>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `https://github.com/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`) {
      return new Response(
        pkt('# service=git-upload-pack\n') +
          '0000' +
          pkt(`${V1} HEAD\0symref=HEAD:refs/heads/main\n`) +
          pkt(`${V1} refs/heads/main\n`) +
          Object.entries(tags)
            .map(([tag, commit]) => pkt(`${commit} refs/tags/${tag}\n`))
            .join('') +
          '0000',
      );
    }
    for (const [commit, files] of Object.entries(commits)) {
      if (url === `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/${commit}`) {
        return new Response(new Uint8Array(tarball(files, commit)));
      }
    }
    return new Response('not found', { status: 404 });
  });
}

/** The repo at a commit: the example plugin in its folder, with a manifest changed by `edit`, and other files. */
function repoAt(edit: (manifest: Record<string, unknown>) => void = () => {}): Record<string, string> {
  const files = helloFiles();
  const manifest = JSON.parse(files['potentialpaper-plugin.json']);
  edit(manifest);
  const out: Record<string, string> = { 'README.md': '# The site', 'src/app.ts': 'export {}' };
  for (const [name, content] of Object.entries(files)) {
    out[`${FOLDER}/${name}`] = name === 'potentialpaper-plugin.json' ? JSON.stringify(manifest) : content;
  }
  return out;
}

let store: string;
beforeAll(() => {
  store = mkdtempSync(join(tmpdir(), 'plugin-store-'));
  process.env.DEMOS_DIR = store;
});
afterAll(async () => {
  rmSync(store, { recursive: true, force: true });
  await closePool();
});
beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

const installed = async (cookie?: string, page?: string) =>
  (await api('GET', `/plugins/installed${page ? `?page=${encodeURIComponent(page)}` : ''}`, { cookie })).body;

describe('installing a plugin', () => {
  it('copies it at the commit its tag names, lists it in settings.json, and runs it once approved', async () => {
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub({ [V1]: repoAt() }, { 'v1.0.0': V1 }));

    const res = await api('POST', '/me/plugins', { cookie, body: { source: `${SOURCE}@v1.0.0` } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      source: SOURCE,
      ref: 'v1.0.0',
      from: 'user',
      status: 'consent',
      plugin: { id: 'potentialhedge/hello', commit: V1 },
      missing: { permissions: ['page.read'], network: [] },
    });
    const host = pluginHostLabel('potentialhedge/hello');
    expect(res.body.plugin.baseUrl).toBe(pluginBaseUrl(host, V1));

    // settings.json names it, and its settings resolve and check like the site's own.
    const settings = (await api('GET', '/me/settings', { cookie })).body;
    expect(JSON.parse(settings.text).plugins).toEqual({ [SOURCE]: { enabled: true, ref: 'v1.0.0' } });
    expect(settings.values).toMatchObject({
      'potentialhedge/hello.greeting': 'Hello',
      'potentialhedge/hello.showScopes': true,
    });
    const bad = await api('PUT', '/me/settings', { cookie, text: '{ "potentialhedge/hello.showScopes": "yes" }' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain('potentialhedge/hello.showScopes: must be true or false');
    const schema = await (
      await import('@/app/schemas/[file]/route')
    ).GET(
      new Request('http://test.local/schemas/settings.json', { headers: { cookie, origin: 'http://test.local' } }),
      { params: Promise.resolve({ file: 'settings.json' }) },
    );
    expect(Object.keys((await schema.json()).properties)).toContain('potentialhedge/hello.greeting');

    // Approving it, at the commit it runs.
    expect(
      (await api('PUT', '/me/plugins/grants', { cookie, body: { plugin: 'potentialhedge/hello', commit: V2 } })).status,
    ).toBe(409);
    expect(
      (await api('PUT', '/me/plugins/grants', { cookie, body: { plugin: 'potentialhedge/hello', commit: V1 } })).status,
    ).toBe(200);
    expect((await installed(cookie)).plugins).toMatchObject([{ status: 'ready', missing: { permissions: [] } }]);

    // A new version that asks for more needs consent again; one that doesn't, doesn't.
    vi.stubGlobal(
      'fetch',
      fakeGitHub(
        {
          [V2]: repoAt((m) => {
            m.version = '1.1.0';
            m.permissions = ['page.read', 'scope.read'];
            m.network = ['https://api.example.org'];
          }),
        },
        { 'v1.0.0': V1, 'v1.1.0': V2 },
      ),
    );
    expect((await api('POST', '/me/plugins', { cookie, body: { source: `${SOURCE}@v1.1.0` } })).body).toMatchObject({
      status: 'consent',
      plugin: { commit: V2, manifest: { version: '1.1.0' } },
      missing: { permissions: ['scope.read'], network: ['https://api.example.org'] },
    });
    // Only one entry per source: the ref moved.
    expect(JSON.parse((await api('GET', '/me/settings', { cookie })).body.text).plugins).toEqual({
      [SOURCE]: { enabled: true, ref: 'v1.1.0' },
    });

    // Removing it takes it out of the file.
    expect((await api('DELETE', `/me/plugins?source=${encodeURIComponent(SOURCE)}`, { cookie })).status).toBe(200);
    expect((await installed(cookie)).plugins).toEqual([]);
  });

  it('refuses a plugin whose manifest is wrong, listing every problem, and one that claims another owner', async () => {
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal(
      'fetch',
      fakeGitHub(
        {
          [V1]: repoAt((m) => {
            m.id = 'someone-else/hello';
            m.main = 'dist/index.html';
            m.permissions = ['everything'];
          }),
        },
        { v1: V1 },
      ),
    );
    const res = await api('POST', '/me/plugins', { cookie, body: { source: `${SOURCE}@v1` } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.problems).toEqual([
      expect.stringMatching(/^potentialpaper-plugin\.json: permissions\[0\]: /),
    ]);

    vi.stubGlobal('fetch', fakeGitHub({ [V1]: repoAt((m) => (m.id = 'someone-else/hello')) }, { v1: V1 }));
    const theirs = await api('POST', '/me/plugins', { cookie, body: { source: `${SOURCE}@v1` } });
    expect(theirs.status).toBe(422);
    expect(theirs.body.error.message).toContain('must start with the repo\'s owner, as "potentialhedge/hello"');
    expect(JSON.parse((await api('GET', '/me/settings', { cookie })).body.text).plugins).toBeUndefined();
  });
});

describe('serving a plugin', () => {
  it('serves its files at their commit from its own origin, with its own CSP, and nothing else', async () => {
    const source = { kind: 'github' as const, owner: OWNER, repo: REPO, path: FOLDER, ref: null };
    const files = Object.entries({ ...helloFiles(), 'secret.ts': 'x', '.env.json': '{}' }).map(([path, text]) => ({
      path,
      bytes: Buffer.from(text),
    }));
    const snapshot = await storePluginFiles(source, V1, files);
    expect(Object.keys(snapshot.files).sort()).toEqual(
      ['README.md', 'index.html', 'main.js', 'potentialpaper-plugin.json', 'style.css'].sort(),
    );
    const host = pluginHostLabel('potentialhedge/hello');
    const get = (path: string, label = host) => servePlugin(new Request(`${pluginBaseUrl(label, V1)}${path}`), label);

    const page = await get('index.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(page.headers.get('content-security-policy')).toMatch(
      /connect-src 'self'; .*frame-ancestors http:\/\/test\.local/,
    );
    expect(await page.text()).toBe(helloFiles()['index.html']);
    expect((await get('')).status).toBe(200);
    expect((await get('main.js')).headers.get('content-type')).toMatch(/^text\/javascript/);
    for (const missing of ['secret.ts', '.env.json']) expect((await get(missing)).status).toBe(404);
    expect((await get('index.html', 'plugin-00000000000000000000')).status).toBe(404);
    expect((await servePlugin(new Request(`${pluginBaseUrl(host, V2)}index.html`), host)).status).toBe(404);
  });
});

describe("the site's plugins", () => {
  async function hello() {
    const source = { kind: 'github' as const, owner: OWNER, repo: REPO, path: FOLDER, ref: null };
    const files = Object.entries(helloFiles()).map(([path, text]) => ({ path, bytes: Buffer.from(text) }));
    await storePluginFiles(source, V1, files);
    await pinPlugin(SOURCE, 'v1', V1);
  }

  it('runs plugins.default for everyone, signed in or not, until a reader turns one off', async () => {
    await hello();
    await saveSiteSettings(`{ "plugins.default": ["${SOURCE}@v1"] }`);
    const anonymous = await installed();
    expect(anonymous).toMatchObject({
      viewer: { signedIn: false, isOwner: false },
      plugins: [{ from: 'site', status: 'ready', plugin: { id: 'potentialhedge/hello', commit: V1 } }],
    });
    // Signed-out readers resolve the site's plugins' settings too.
    expect((await api('GET', '/settings')).body.plugins).toEqual([
      expect.objectContaining({ id: 'potentialhedge/hello' }),
    ]);

    const cookie = await signUp('ada@ethz.ch');
    expect((await installed(cookie)).plugins[0]).toMatchObject({ from: 'site', status: 'ready' });
    await api('PUT', '/me/settings', { cookie, text: `{ "plugins": { "${SOURCE}": { "enabled": false } } }` });
    expect((await installed(cookie)).plugins[0]).toMatchObject({ status: 'disabled' });
    // Removing a default turns it off rather than leaving it installed.
    await api('PUT', '/me/settings', { cookie, text: '{}' });
    await api('DELETE', `/me/plugins?source=${encodeURIComponent(SOURCE)}`, { cookie });
    expect(JSON.parse((await api('GET', '/me/settings', { cookie })).body.text).plugins).toEqual({
      [SOURCE]: { enabled: false },
    });
  });

  it('stops a blocked plugin for everyone, by id or at one commit', async () => {
    await hello();
    await saveSiteSettings(
      `{ "plugins.default": ["${SOURCE}@v1"], "plugins.blocked": ["potentialhedge/hello@${V2}"] }`,
    );
    expect((await installed()).plugins[0].status).toBe('ready');
    await saveSiteSettings(
      `{ "plugins.default": ["${SOURCE}@v1"], "plugins.blocked": ["potentialhedge/hello@${V1}"] }`,
    );
    expect((await installed()).plugins[0].status).toBe('blocked');
    // A reader can't unblock it, whatever their file says.
    const cookie = await signUp('ada@ethz.ch');
    await api('PUT', '/me/settings', { cookie, text: '{ "plugins.blocked": [] }' });
    expect((await installed(cookie)).plugins[0].status).toBe('blocked');
  });
});

describe("a plugin's storage", () => {
  it('keeps small state per account and plugin, up to 64 KB', async () => {
    const ada = await signUp('ada@ethz.ch');
    const bob = await signUp('bob@ethz.ch');
    const put = (cookie: string, key: string, value: unknown) =>
      api('PUT', '/me/plugins/storage', { cookie, body: { plugin: 'potentialhedge/hello', key, value } });
    expect((await put(ada, 'visits', 3)).body).toMatchObject({ data: { visits: 3 } });
    expect((await api('GET', '/me/plugins/storage?plugin=potentialhedge%2Fhello', { cookie: ada })).body.data).toEqual({
      visits: 3,
    });
    expect((await api('GET', '/me/plugins/storage?plugin=potentialhedge%2Fhello', { cookie: bob })).body.data).toEqual(
      {},
    );
    const big = await put(ada, 'big', 'x'.repeat(70 * 1024));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('storage_full');
    expect((await put(ada, 'visits', null)).body.data).toEqual({});
    expect((await api('GET', '/me/plugins/storage?plugin=potentialhedge%2Fhello')).status).toBe(401);
  });
});

describe('the page routes plugins read', () => {
  const venueId = 'ICLR.cc/2027/Conference';
  async function catchUp() {
    for (const consumer of CONSUMERS) {
      expect(await runConsumer(consumer, { retryNow: true })).toMatchObject({ status: 'caught-up' });
    }
    // The scopes the consumers marked: their score statistics (`page.hasScores` on a venue).
    await recomputeDueScopes({ all: true });
  }

  it('resolves any kind, with scopes and facts, and reads files, members and reviews', async () => {
    const [admin] = await getDb().insert(accounts).values({ handle: 'admin', verifiedAt: new Date() }).returning();
    const actor = { kind: 'account' as const, accountId: admin.id, isAdmin: true };
    const paper = await savePaper({
      title: 'Linear attention at scale',
      authors: ['A. Author'],
      abstract: 'We scale it.',
      year: 2027,
      venue: null,
      source: 'arxiv',
      metadataLicense: 'CC0-1.0',
      abstractLicense: null,
      identifiers: [{ scheme: 'arxiv', value: '2701.00001' }],
    });
    await createPage('venue', 'iclr');
    const venue = await createPage('venue', 'iclr/2027');
    await commitPage(
      venue.id,
      venue.head,
      actor,
      [
        { path: 'venue.json', content: JSON.stringify({ name: 'ICLR 2027', sources: [`openreview:${venueId}`] }) },
        { path: 'community/10-about.md', content: 'The 2027 edition.\n' },
      ],
      'Venue',
    );
    const bot = await ensureBot(OPENREVIEW_BOT);
    await grantBot(OPENREVIEW_BOT, 'reviews/openreview/**', { grantedBy: 'system' });
    await commitPage(
      paper,
      null,
      bot,
      [
        {
          path: submissionFilePath('openreview', 'forum1'),
          content: encodeReviewFile({
            schema: 'submission/1',
            id: 'forum1',
            venue: { id: venueId, name: 'ICLR 2027', url: null },
            number: 1,
            status: 'under_review',
            decision: null,
            url: 'https://openreview.net/forum?id=forum1',
            license: 'CC-BY-4.0',
          }),
        },
        {
          // The venue's forms mark the rating a score, which is what its statistics count.
          path: formsFilePath('openreview', 'forum1'),
          content: encodeReviewFile({
            schema: 'forms/1',
            forms: {
              Official_Review: {
                label: 'Official review',
                fields: [{ key: 'rating', label: 'Rating', type: 'score' }],
              },
            },
            url: 'https://openreview.net/group?id=ICLR.cc/2027/Conference',
            license: 'CC-BY-4.0',
          }),
        },
        {
          path: noteFilePath('openreview', 'forum1', 'r1'),
          content: encodeReviewFile({
            schema: 'review/1',
            id: 'r1',
            replyTo: null,
            kind: 'review',
            invitation: 'Official_Review',
            signature: 'Reviewer B3x7',
            content: { rating: 6 },
            createdAt: '2026-11-01T12:00:00.000Z',
            url: 'https://openreview.net/forum?id=forum1&noteId=r1',
            license: 'CC-BY-4.0',
          } satisfies NoteFile),
        },
      ],
      'Import',
    );
    await catchUp();

    const enc = encodeURIComponent;
    const paperSummary = await api('GET', `/pages/${enc('arxiv:2701.00001')}`);
    expect(paperSummary.status).toBe(200);
    expect(paperSummary.body).toMatchObject({
      kind: 'paper',
      identifier: 'arxiv:2701.00001',
      address: '/abs/2701.00001',
      name: 'Linear attention at scale',
      scopes: [{ kind: 'venue', identifier: 'venue:iclr/2027', name: 'ICLR 2027', address: '/v/iclr/2027' }],
      facts: { hasSubmissions: true, hasScores: true },
    });
    expect((await api('GET', `/pages/${enc('venue:iclr/2027')}`)).body).toMatchObject({
      name: 'ICLR 2027',
      scopes: [{ identifier: 'venue:iclr' }],
      facts: { hasSubmissions: true, hasScores: true },
    });
    expect((await api('GET', `/pages/${enc('topic:nothing-here')}`)).status).toBe(404);

    const files = (await api('GET', `/pages/${enc('venue:iclr/2027')}/files`)).body;
    expect(files).toMatchObject({
      kindFile: { name: 'ICLR 2027' },
      sections: [{ part: 'community', path: 'community/10-about.md', markdown: 'The 2027 edition.\n' }],
      links: [],
    });
    expect((await api('GET', `/pages/${enc('arxiv:2701.00001')}/files`)).body.kindFile).toMatchObject({
      title: 'Linear attention at scale',
      identifiers: ['arxiv:2701.00001'],
    });

    // The series rolls up its editions' papers.
    const members = (await api('GET', `/pages/${enc('venue:iclr')}/members?limit=10`)).body;
    expect(members).toMatchObject({
      total: 1,
      papers: [{ identifier: 'arxiv:2701.00001', year: 2027, via: ['submission'] }],
      nextOffset: null,
    });
    expect((await api('GET', `/pages/${enc('venue:iclr')}/members?rollUp=false`)).body.total).toBe(0);
    expect((await api('GET', `/pages/${enc('arxiv:2701.00001')}/members`)).status).toBe(422);

    const reviews = (await api('GET', `/pages/${enc('arxiv:2701.00001')}/submissions`)).body;
    expect(reviews.submissions).toMatchObject([
      { venue: { id: `openreview:${venueId}` }, notes: [{ kind: 'review', content: { rating: 6 } }] },
    ]);

    // Whether the reader owns the page, for `viewer.isOwner`: a user page is its account's.
    const cookie = await signUp('ada@ethz.ch');
    const me = (await api('GET', '/me', { cookie })).body.handle;
    await createPage('user', me);
    expect((await installed(cookie, `user:${me}`)).viewer).toEqual({ signedIn: true, isOwner: true });
    expect((await installed(cookie, 'venue:iclr/2027')).viewer).toEqual({ signedIn: true, isOwner: false });
  });
});

describe('releases and updates', () => {
  const V3 = '3'.repeat(40);
  const bump =
    (version: string, more: string[] = []) =>
    (m: Record<string, unknown>) => {
      m.version = version;
      m.permissions = ['page.read', ...more];
    };
  beforeEach(forgetTags);

  it('installs the newest release when no ref is named, and moves to a newer one, asking first for new permissions', async () => {
    const cookie = await signUp('ada@ethz.ch');
    const [account] = await getDb().select().from(accounts);
    const { token } = await mintToken({ account, name: 'agent', scopes: ['write'] });
    vi.stubGlobal('fetch', fakeGitHub({ [V1]: repoAt() }, { 'v0.9.0': V1, 'v1.0.0': V1, 'v2.0.0-rc.1': V1 }));
    const res = await api('POST', '/me/plugins', { cookie, body: { source: SOURCE } });
    expect(res.body).toMatchObject({ ref: 'v1.0.0', plugin: { commit: V1 } });
    expect((await api('GET', '/me/plugins/updates', { cookie })).body).toEqual({ updates: [] });
    await api('PUT', '/me/plugins/grants', { cookie, body: { plugin: 'potentialhedge/hello', commit: V1 } });

    // v1.1.0 asks for nothing new: it is offered, and switches at once, for an agent too.
    vi.stubGlobal('fetch', fakeGitHub({ [V1]: repoAt(), [V2]: repoAt(bump('1.1.0')) }, { 'v1.0.0': V1, 'v1.1.0': V2 }));
    forgetTags();
    expect((await api('GET', '/me/plugins/updates', { cookie })).body.updates).toEqual([
      {
        source: SOURCE,
        pluginId: 'potentialhedge/hello',
        current: { ref: 'v1.0.0', commit: V1, version: '1.0.0' },
        latest: { tag: 'v1.1.0', commit: V2, version: '1.1.0' },
      },
    ]);
    const updated = await api('POST', '/me/plugins/updates', { token, body: { source: SOURCE } });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ status: 'updated', plugin: { ref: 'v1.1.0', status: 'ready' } });
    expect(updated.body.plugin.plugin).toMatchObject({ commit: V2, manifest: { version: '1.1.0' } });
    expect(JSON.parse((await api('GET', '/me/settings', { cookie })).body.text).plugins).toEqual({
      [SOURCE]: { enabled: true, ref: 'v1.1.0' },
    });
    expect((await api('GET', '/me/plugins/updates', { cookie })).body.updates).toEqual([]);

    // v1.2.0 asks for scope.read: described, nothing switched, until the reader approves it in a browser.
    vi.stubGlobal(
      'fetch',
      fakeGitHub(
        { [V2]: repoAt(bump('1.1.0')), [V3]: repoAt(bump('1.2.0', ['scope.read'])) },
        { 'v1.1.0': V2, 'v1.2.0': V3 },
      ),
    );
    forgetTags();
    const asked = await api('POST', '/me/plugins/updates', { cookie, body: { source: SOURCE } });
    expect(asked.body).toEqual({
      status: 'consent',
      to: { ref: 'v1.2.0', commit: V3, version: '1.2.0', name: 'Hello' },
      missing: { permissions: ['scope.read'], network: [] },
    });
    expect((await installed(cookie)).plugins).toMatchObject([{ ref: 'v1.1.0', status: 'ready' }]);
    const byAgent = await api('POST', '/me/plugins/updates', { token, body: { source: SOURCE, approve: true } });
    expect(byAgent.status).toBe(403);
    const approved = await api('POST', '/me/plugins/updates', { cookie, body: { source: SOURCE, approve: true } });
    expect(approved.body).toMatchObject({ status: 'updated', plugin: { ref: 'v1.2.0', status: 'ready' } });
    expect((await installed(cookie)).plugins).toMatchObject([
      { ref: 'v1.2.0', status: 'ready', plugin: { commit: V3 }, missing: { permissions: [], network: [] } },
    ]);

    // A ref that isn't there changes nothing; nor does a plugin that isn't installed.
    expect((await api('POST', '/me/plugins/updates', { cookie, body: { source: SOURCE, ref: 'v9' } })).status).toBe(
      422,
    );
    expect((await api('POST', '/me/plugins/updates', { cookie, body: { source: 'github:someone/else' } })).status).toBe(
      404,
    );
  });

  it("re-pins a site default for the reader alone, who must approve it, since it's theirs from then on", async () => {
    const cookie = await signUp('ada@ethz.ch');
    vi.stubGlobal('fetch', fakeGitHub({ [V1]: repoAt(), [V2]: repoAt(bump('1.1.0')) }, { 'v1.0.0': V1, 'v1.1.0': V2 }));
    const source = { kind: 'github' as const, owner: OWNER, repo: REPO, path: FOLDER, ref: null };
    await storePluginFiles(
      source,
      V1,
      Object.entries(helloFiles()).map(([path, t]) => ({ path, bytes: Buffer.from(t) })),
    );
    await pinPlugin(SOURCE, 'v1.0.0', V1);
    await saveSiteSettings(`{ "plugins.default": ["${SOURCE}@v1.0.0"] }`);
    expect((await api('GET', '/me/plugins/updates', { cookie })).body.updates).toMatchObject([
      { latest: { tag: 'v1.1.0' } },
    ]);
    const asked = await api('POST', '/me/plugins/updates', { cookie, body: { source: SOURCE } });
    expect(asked.body).toMatchObject({ status: 'consent', missing: { permissions: ['page.read'] } });
    await api('POST', '/me/plugins/updates', { cookie, body: { source: SOURCE, approve: true } });
    expect((await installed(cookie)).plugins).toMatchObject([{ from: 'user', ref: 'v1.1.0', status: 'ready' }]);
    // Everyone else still runs the site's.
    expect((await installed()).plugins).toMatchObject([{ from: 'site', ref: 'v1.0.0', plugin: { commit: V1 } }]);
  });
});

describe('discovering plugins', () => {
  it('lists the topic’s repos from GitHub, publicly, cached five minutes', async () => {
    const search = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://api.github.com/search/repositories')) return new Response('', { status: 404 });
      return Response.json({
        items: [
          {
            name: 'potentialpaper-score-standing',
            owner: { login: 'benedict-armstrong' },
            html_url: 'https://github.com/benedict-armstrong/potentialpaper-score-standing',
            description: 'Where you stand',
            stargazers_count: 3,
            pushed_at: '2026-11-15T10:00:00Z',
            topics: ['potentialpaper-plugin'],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', search);
    const { GET } = await import('@/app/api/v1/plugins/discover/route');
    const raw = await GET(new Request('http://test.local/api/v1/plugins/discover'), { params: Promise.resolve({}) });
    expect(raw.headers.get('cache-control')).toBe('public, max-age=300');
    const res = await api('GET', '/plugins/discover');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stale: false,
      plugins: [{ source: 'github:benedict-armstrong/potentialpaper-score-standing', stars: 3 }],
    });
    expect(search).toHaveBeenCalledTimes(1);
  });
});
