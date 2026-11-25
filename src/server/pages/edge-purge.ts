import { siteUrl } from '../site';

/** Paths the edge keeps by path alone, query strings dropped (Cloudflare's cache rule for `/s/`). */
const SHORT_PATH = /^\/s\/\d{1,12}$/;
/** What one purge call may name, of files or of prefixes. */
const PER_CALL = 30;

/**
 * Drops pages from Cloudflare's cache, when production has a purge token (`CLOUDFLARE_PURGE_TOKEN`, cache purge on this
 * zone only). A paper's page at its short address is kept under its path alone, so `?ref=acceptodds` and the rest share
 * it, and a purge by URL doesn't reach that key: it is purged by prefix, which also drops the pages whose numbers
 * start with its own (`/s/1997` takes `/s/19970` with it), a render each, no harm. Never throws.
 */
export async function purgeEdge(paths: readonly string[]): Promise<void> {
  const token = process.env.CLOUDFLARE_PURGE_TOKEN;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zone || paths.length === 0) return;
  const site = siteUrl();
  const host = new URL(site).host;
  const prefixes = paths.filter((path) => SHORT_PATH.test(path)).map((path) => `${host}${path}`);
  const files = paths.filter((path) => !SHORT_PATH.test(path)).map((path) => `${site}${path}`);
  const calls = [
    ...chunks(prefixes).map((list) => ({ prefixes: list })),
    ...chunks(files).map((list) => ({ files: list })),
  ];
  for (const body of calls) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.error('edge purge', res.status, (await res.text()).slice(0, 200));
    } catch (err) {
      console.error('edge purge', err);
    }
  }
}

function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += PER_CALL) out.push(list.slice(at, at + PER_CALL));
  return out;
}
