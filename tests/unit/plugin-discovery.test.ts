import { describe, expect, it, vi } from 'vitest';
import { compareVersions, newestRelease, parseVersion, updateFor } from '@/lib/plugins/versions';
import { DISCOVER_CACHE_MS, pluginDirectory, PLUGIN_TOPIC } from '@/server/plugins/discover';

/** Discovery (`GET /api/v1/plugins/discover`) and releases (`handoffs/plugins.md` Phase 3). */

describe('plugin releases', () => {
  it('reads versions as tags and manifests write them, in semver order', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: '' });
    expect(parseVersion('1.2.3-beta.2+build')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'beta.2' });
    expect(parseVersion('main')).toBeNull();
    expect(parseVersion('v1.2')).toBeNull();
    const order = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0',
      '1.0.1',
      '1.10.0',
      '2.0.0',
    ];
    for (let i = 1; i < order.length; i++) {
      expect(compareVersions(parseVersion(order[i - 1])!, parseVersion(order[i])!)).toBeLessThan(0);
    }
  });

  it('offers the newest release newer than what runs, never a prerelease', () => {
    const tags = ['v0.9.0', 'v1.0.0', 'v1.10.0', 'v1.2.0', 'v2.0.0-rc.1', 'latest', 'main'];
    expect(newestRelease(tags)?.tag).toBe('v1.10.0');
    expect(updateFor(tags, '1.2.0')).toEqual({ tag: 'v1.10.0', version: '1.10.0' });
    expect(updateFor(tags, '1.10.0')).toBeNull();
    expect(updateFor(tags, '2.0.0-rc.1')).toBeNull();
    expect(updateFor(['latest'], '0.1.0')).toBeNull();
    // `v1.0.0` wins over `1.0.0`, as the guide says to tag.
    expect(newestRelease(['1.0.0', 'v1.0.0'])?.tag).toBe('v1.0.0');
  });
});

function searchResponse(items: unknown[]) {
  return new Response(JSON.stringify({ total_count: items.length, items }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

const ITEM = {
  name: 'potentialpaper-score-standing',
  owner: { login: 'benedict-armstrong', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
  html_url: 'https://github.com/benedict-armstrong/potentialpaper-score-standing',
  description: 'Where a paper stands among its venue’s review scores',
  stargazers_count: 12,
  pushed_at: '2026-11-15T10:00:00Z',
  topics: ['potentialpaper-plugin'],
};

describe('plugin discovery', () => {
  it("asks GitHub's search for the topic, most starred first, and keys each repo as a source", async () => {
    const fetch = vi.fn(async () =>
      searchResponse([ITEM, { ...ITEM, name: 'old', archived: true }, { ...ITEM, name: 'bad name!' }]),
    );
    const list = pluginDirectory(fetch as unknown as typeof globalThis.fetch);
    const result = await list();
    const url = new URL(String((fetch.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe('/search/repositories');
    expect(url.searchParams.get('q')).toBe(`topic:${PLUGIN_TOPIC} archived:false is:public`);
    expect(url.searchParams.get('sort')).toBe('stars');
    expect(result.stale).toBe(false);
    expect(result.plugins).toEqual([
      {
        source: 'github:benedict-armstrong/potentialpaper-score-standing',
        owner: 'benedict-armstrong',
        repo: 'potentialpaper-score-standing',
        description: ITEM.description,
        stars: 12,
        pushedAt: ITEM.pushed_at,
        htmlUrl: ITEM.html_url,
        avatarUrl: ITEM.owner.avatar_url,
        topics: ['potentialpaper-plugin'],
      },
    ]);
  });

  it('serves its answer for five minutes, and the last list while GitHub fails', async () => {
    let now = 1_000_000;
    let fail = false;
    const fetch = vi.fn(async () => (fail ? new Response('rate limited', { status: 403 }) : searchResponse([ITEM])));
    const list = pluginDirectory(fetch as unknown as typeof globalThis.fetch, () => now);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await list();
    now += DISCOVER_CACHE_MS - 1;
    await list();
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 1;
    fail = true;
    const stale = await list();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(stale).toMatchObject({ stale: true, plugins: [{ repo: ITEM.name }] });
    // Not asked again for a minute after a failure.
    await list();
    expect(fetch).toHaveBeenCalledTimes(2);

    now += 60_000;
    fail = false;
    expect((await list()).stale).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('fails with no list to stand in, and tries again after a minute', async () => {
    let now = 0;
    const fetch = vi.fn(async () => new Response('down', { status: 500 }));
    const list = pluginDirectory(fetch as unknown as typeof globalThis.fetch, () => now);
    await expect(list()).rejects.toThrow('HTTP 500');
    await expect(list()).rejects.toThrow('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 60_000;
    await expect(list()).rejects.toThrow('HTTP 500');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('sends GITHUB_TOKEN when it is set', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => searchResponse([]));
    await pluginDirectory(fetch as unknown as typeof globalThis.fetch)();
    expect((fetch.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test');
    vi.unstubAllEnvs();
  });
});

describe('the plugin guide', () => {
  it('documents every RPC method, permission and when key the host has, and how to publish', async () => {
    const { pluginsGuide, METHOD_DOCS } = await import('@/server/agent/plugins-guide');
    const { HOST_METHODS } = await import('@/lib/plugins/protocol');
    const { PERMISSION_NAMES } = await import('@/lib/plugins/manifest');
    const { KINDS, PAGE_KINDS } = await import('@/lib/kinds');
    const guide = pluginsGuide('https://potentialpaper.org');
    expect(guide).toContain('> Follow https://potentialpaper.org/plugins.md for a new PotentialPaper plugin.');
    expect(Object.keys(METHOD_DOCS).sort()).toEqual(Object.keys(HOST_METHODS).sort());
    for (const doc of Object.values(METHOD_DOCS)) expect(guide).toContain(doc.call);
    for (const p of PERMISSION_NAMES) expect(guide).toContain(`| \`${p}\` |`);
    for (const k of PAGE_KINDS) for (const key of KINDS[k].contextKeys) expect(guide).toContain(`\`${key}\``);
    expect(guide).toContain(`gh repo edit --add-topic ${PLUGIN_TOPIC}`);
    expect(guide).toContain('git tag v0.1.0');
    expect(guide).toContain('npx http-server . -p 5174 --cors');
  });
});
