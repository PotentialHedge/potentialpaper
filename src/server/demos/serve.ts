import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { demoSnapshots, type DemoFile } from '@/db/schema';
import { DEMO_ORIGIN, DEMO_PREFIX, isSnapshotId } from '@/lib/demos';
import { siteUrl } from '../site';
import { getBlob } from './store';

/**
 * Answers every request to the demo host. `/d/<snapshot>/<path>` is a file of a snapshot. Anything else is a
 * build that asks for its files from the root, as Vite's do by default (`/assets/index.js`): the page that
 * asked is in the `Referer`, so the request is sent on to the same path inside that page's snapshot. The
 * redirect matters: the module it reaches then imports with its new address as the base.
 */

/** A snapshot's file list never changes, so it can be kept for as long as the process runs. */
const manifests = new Map<string, Record<string, DemoFile> | null>();
const MAX_KEPT = 500;

async function manifest(id: string): Promise<Record<string, DemoFile> | null> {
  if (manifests.has(id)) return manifests.get(id)!;
  const [row] = await getDb()
    .select({ files: demoSnapshots.files })
    .from(demoSnapshots)
    .where(eq(demoSnapshots.id, id));
  const files = row?.files ?? null;
  // Only found ones: a snapshot that doesn't exist yet may exist in a moment.
  if (files) {
    if (manifests.size >= MAX_KEPT) manifests.delete(manifests.keys().next().value!);
    manifests.set(id, files);
  }
  return files;
}

function headers(type: string): Record<string, string> {
  return {
    'Content-Type': type,
    // The snapshot id is a hash of its files, so an address always means the same bytes.
    'Cache-Control': 'public, max-age=31536000, immutable',
    // Only the paper pages may frame a demo.
    'Content-Security-Policy': `frame-ancestors ${new URL(siteUrl()).origin}`,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

const NOT_FOUND = () =>
  new Response('Not found\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** The file a path asks for: itself, or the `index.html` of the folder it names. */
export function findFile(files: Record<string, DemoFile>, path: string): string | null {
  const clean = path.replace(/^\/+/, '');
  if (clean === '' || clean.endsWith('/')) return files[`${clean}index.html`] ? `${clean}index.html` : null;
  if (files[clean]) return clean;
  if (files[`${clean}/index.html`]) return `${clean}/index.html`;
  return null;
}

/** `/d/<id>/<rest>` split, or `null`. */
export function splitDemoPath(pathname: string): { id: string; rest: string } | null {
  if (!pathname.startsWith(DEMO_PREFIX)) return null;
  const after = pathname.slice(DEMO_PREFIX.length);
  const slash = after.indexOf('/');
  const id = slash === -1 ? after : after.slice(0, slash);
  if (!isSnapshotId(id)) return null;
  return { id, rest: slash === -1 ? '' : after.slice(slash + 1) };
}

export async function serveDemo(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const url = new URL(req.url);
  const pathname = decodeURIComponent(url.pathname);
  const inside = splitDemoPath(pathname);

  if (!inside) {
    const referer = URL.parse(req.headers.get('referer') ?? '');
    // The Host header, not `url`, whose host a proxy in front may have rewritten.
    const host = req.headers.get('host') ?? url.host;
    const from = referer && referer.host === host ? splitDemoPath(referer.pathname) : null;
    if (!from) return NOT_FOUND();
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${DEMO_ORIGIN}${DEMO_PREFIX}${from.id}${url.pathname}${url.search}`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // Without the slash, the demo's relative addresses would resolve against `/d/`.
  if (pathname === `${DEMO_PREFIX}${inside.id}`) {
    return new Response(null, {
      status: 308,
      headers: {
        Location: `${DEMO_ORIGIN}${DEMO_PREFIX}${inside.id}/${url.search}`,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  const files = await manifest(inside.id);
  if (!files) return NOT_FOUND();
  const path = findFile(files, inside.rest);
  if (!path) return NOT_FOUND();
  const file = files[path];
  const body = await getBlob(file.sha256);
  if (!body) {
    console.error(`demo ${inside.id}: ${path} (${file.sha256}) is not in the store`);
    return new Response('The file is missing\n', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  return new Response(req.method === 'HEAD' ? null : body, {
    headers: { ...headers(file.type), 'Content-Length': String(file.bytes) },
  });
}
