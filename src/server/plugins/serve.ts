import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { pluginSnapshots, type DemoFile } from '@/db/schema';
import type { PluginManifest } from '@/lib/plugins/manifest';
import { PUBLIC_SDK_BASE, SDK_BASE } from '@/lib/plugins/origin';
import { getBlob } from '../demos/store';
import { findFile } from '../demos/serve';
import { siteUrl } from '../site';

/**
 * Answers every request to a plugin's host, `<label>.<content domain>` (`lib/plugins/origin.ts`): `/<commit>/<path>`
 * is a file of the plugin at that commit, unchanged (nothing is added to its pages, unlike a demo's). Beside
 * `server/demos/serve.ts`, and reached the same way, from `proxy.ts`.
 *
 * The CSP is the plugin's own: `default-src 'self'`, scripts from itself and the SDK, and `connect-src` its own
 * origin and the `network` origins its manifest names (checked when it was copied, and shown in the consent prompt).
 * Only the site may frame it. Everything is cached for good: a commit's files never change.
 */

interface Served {
  files: Record<string, DemoFile>;
  network: string[];
}

const kept = new Map<string, Served>();
const MAX_KEPT = 500;

async function snapshotAt(host: string, commit: string): Promise<Served | null> {
  const id = `${host}/${commit}`;
  if (kept.has(id)) return kept.get(id)!;
  const [row] = await getDb()
    .select({ files: pluginSnapshots.files, manifest: pluginSnapshots.manifest })
    .from(pluginSnapshots)
    .where(and(eq(pluginSnapshots.host, host), eq(pluginSnapshots.commit, commit)));
  if (!row) return null;
  const served = { files: row.files, network: (row.manifest as unknown as PluginManifest).network ?? [] };
  if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value!);
  kept.set(id, served);
  return served;
}

/** The plugin's content security policy. */
export function pluginCsp(network: readonly string[]): string {
  return [
    "default-src 'self'",
    // WebAssembly is among the files a plugin may ship, and compiling it needs this; `eval` stays off.
    `script-src 'self' 'wasm-unsafe-eval' ${[...new Set([SDK_BASE, PUBLIC_SDK_BASE])].join(' ')}`,
    // Libraries set inline styles; styles can't reach anything outside the frame.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    ['connect-src', "'self'", ...network].join(' '),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    `frame-ancestors ${new URL(siteUrl()).origin}`,
  ].join('; ');
}

const NOT_FOUND = () =>
  new Response('Not found\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export async function servePlugin(req: Request, host: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const pathname = decodeURIComponent(new URL(req.url).pathname);
  const match = /^\/([0-9a-f]{40})(\/.*)?$/.exec(pathname);
  if (!match) return NOT_FOUND();
  const snapshot = await snapshotAt(host, match[1]);
  if (!snapshot) return NOT_FOUND();
  const path = findFile(snapshot.files, match[2] ?? '/');
  if (!path) return NOT_FOUND();
  const file = snapshot.files[path];
  const body = await getBlob(file.sha256);
  if (!body) {
    console.error(`plugin ${host}/${match[1]}: ${path} (${file.sha256}) is not in the store`);
    return new Response('The file is missing\n', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(req.method === 'HEAD' ? null : body, {
    headers: {
      'Content-Type': file.type,
      'Content-Length': String(file.bytes),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': pluginCsp(snapshot.network),
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
