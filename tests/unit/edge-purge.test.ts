import { afterEach, describe, expect, it, vi } from 'vitest';
import { purgeEdge } from '@/server/pages/edge-purge';

describe('purgeEdge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function calls() {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"success":true}'));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('purges a short address by prefix, so its ?ref= copies go too, and other pages by URL, 30 a call', async () => {
    vi.stubEnv('CLOUDFLARE_PURGE_TOKEN', 'token');
    vi.stubEnv('CLOUDFLARE_ZONE_ID', 'zone');
    vi.stubEnv('APP_URL', 'https://potentialpaper.com');
    const fetchMock = calls();
    const shorts = Array.from({ length: 31 }, (_, i) => `/s/${i + 1}`);
    await purgeEdge([...shorts, '/openreview/abc']);
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(init?.body as string));
    expect(bodies).toEqual([
      { prefixes: shorts.slice(0, 30).map((p) => `potentialpaper.com${p}`) },
      { prefixes: ['potentialpaper.com/s/31'] },
      { files: ['https://potentialpaper.com/openreview/abc'] },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cloudflare.com/client/v4/zones/zone/purge_cache');
  });

  it('does nothing without a token', async () => {
    vi.stubEnv('CLOUDFLARE_PURGE_TOKEN', '');
    const fetchMock = calls();
    await purgeEdge(['/s/1']);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
