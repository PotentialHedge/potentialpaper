import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { demoSnapshots, type DemoFile } from '@/db/schema';
import { CONTENT_SOURCE, DEMO_HEIGHT_MESSAGE } from '@/lib/demos';
import { siteFramers } from '../site';
import { getBlob } from './store';

/**
 * Answers every request to a demo's host, `<snapshot>.<content domain>` (`lib/demos.ts`): each path is a file of
 * that snapshot, so a build that asks for its files from the root (`/assets/index.js`, as Vite's do) finds them.
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

/**
 * Added to each HTML page of a demo: tells the paper page how tall the content is, whenever that changes,
 * so the frame takes the demo's own shape. It measures the body rather than the document, which is never
 * shorter than the frame and so could only grow.
 */
export const HEIGHT_REPORTER = `<script data-potentialpaper>(()=>{if(parent===window)return;let last=0;const send=()=>{const b=document.body;if(!b)return;const s=getComputedStyle(b);const h=Math.ceil(b.getBoundingClientRect().bottom+parseFloat(s.marginBottom)+window.scrollY);if(h!==last){last=h;parent.postMessage({type:${JSON.stringify(DEMO_HEIGHT_MESSAGE)},height:h},"*")}};const watch=()=>{send();new ResizeObserver(send).observe(document.body)};document.body?watch():addEventListener("DOMContentLoaded",watch);addEventListener("load",send)})()</script>`;

/** The page with the reporter, after `<head>` (or the doctype), so the page keeps its standards mode. */
export function withHeightReporter(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head)
    return html.slice(0, head.index + head[0].length) + HEIGHT_REPORTER + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + HEIGHT_REPORTER + html.slice(doctype[0].length);
  return HEIGHT_REPORTER + html;
}

async function readAll(body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>): Promise<string> {
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  return new Response(body).text();
}

function headers(type: string): Record<string, string> {
  return {
    'Content-Type': type,
    // The snapshot id is a hash of its files, so an address always means the same bytes. Except a page,
    // which has the reporter added and may get a newer one.
    'Cache-Control': type.startsWith('text/html') ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
    // Only the paper pages may frame a demo, and the web editor's preview, a webview on the content domain.
    'Content-Security-Policy': `frame-ancestors ${siteFramers()} ${CONTENT_SOURCE}`,
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

export async function serveDemo(req: Request, snapshot: string): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  const files = await manifest(snapshot);
  if (!files) return NOT_FOUND();
  const path = findFile(files, decodeURIComponent(new URL(req.url).pathname));
  if (!path) return NOT_FOUND();
  const file = files[path];
  const body = await getBlob(file.sha256);
  if (!body) {
    console.error(`demo ${snapshot}: ${path} (${file.sha256}) is not in the store`);
    return new Response('The file is missing\n', { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
  if (file.type.startsWith('text/html')) {
    const page = Buffer.from(withHeightReporter(await readAll(body)));
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(page), {
      headers: { ...headers(file.type), 'Content-Length': String(page.length) },
    });
  }
  return new Response(req.method === 'HEAD' ? null : body, {
    headers: { ...headers(file.type), 'Content-Length': String(file.bytes) },
  });
}
