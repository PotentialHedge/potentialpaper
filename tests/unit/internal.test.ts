import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const revalidated: string[] = [];
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => revalidated.push(path) }));

const { POST } = await import('@/app/api/internal/revalidate/route');
const { revalidateInApp } = await import('@/server/internal');

afterEach(() => {
  revalidated.length = 0;
  delete process.env.APP_INTERNAL_URL;
});

/** The app's route behind a real HTTP server, as `APP_INTERNAL_URL` would name it. */
async function app() {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await POST(
      new Request(`http://app${req.url}`, {
        method: 'POST',
        headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' },
        body: Buffer.concat(chunks),
      }),
    );
    res.writeHead(response.status);
    res.end(await response.text());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe('revalidating pages from outside Next', () => {
  it('asks the app, which revalidates the paper pages', async () => {
    const { url, close } = await app();
    try {
      process.env.APP_INTERNAL_URL = url;
      expect(await revalidateInApp(['/abs/1706.03762', '/doi/10.1000/xyz'])).toBe(true);
      expect(revalidated).toEqual(['/abs/1706.03762', '/doi/10.1000/xyz']);
      // Only paper pages.
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await revalidateInApp(['/profile'])).toBe(false);
      expect(revalidated).toHaveLength(2);
    } finally {
      close();
    }
  });

  it('does nothing without an app to ask', async () => {
    expect(await revalidateInApp(['/abs/1706.03762'])).toBe(false);
  });

  it('answers 404 to anyone without the internal credential', async () => {
    for (const authorization of ['', 'Bearer nope', 'Basic Zm9vOmJhcg==']) {
      const res = await POST(
        new Request('http://app/api/internal/revalidate', {
          method: 'POST',
          headers: { authorization },
          body: JSON.stringify({ paths: ['/abs/1706.03762'] }),
        }),
      );
      expect(res.status).toBe(404);
    }
    expect(revalidated).toEqual([]);
  });
});
