import { and, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getDb } from '@/db';
import { pages, paperIdentifiers } from '@/db/schema';
import { type PageAddress, pagePath } from '@/lib/kinds';
import { paperPath, type PaperId } from '@/lib/paper-ids';
import { revalidateInApp } from '../internal';
import { siteUrl } from '../site';
import { pageOf } from './kinds';
import type { Reader } from './repo';

/**
 * After a commit, makes the paper's pages show it: Next renders them again on their next request, and
 * Cloudflare drops its copies when production has a purge token (TODO.md). Never fails the commit, which
 * has happened by now.
 *
 * `revalidatePath` only works inside a Next request. Outside one (the SSH server, scripts) the app is asked to
 * do it (`revalidateInApp`), when `APP_INTERNAL_URL` says where it is; tests have none.
 */
export async function refreshPaperPages(identifiers: readonly PaperId[]): Promise<void> {
  await refreshPaths(await paperPaths(getDb(), identifiers));
}

/**
 * A paper's addresses: each identifier's, whose route renders it, and its short one, `/s/<n>`, where it is shown and
 * the edge keeps it.
 */
async function paperPaths(db: Reader, identifiers: readonly PaperId[]): Promise<string[]> {
  const paths = identifiers.map(paperPath);
  const [first] = identifiers;
  if (!first) return paths;
  const rows = await db
    .select({ shortId: pages.shortId })
    .from(paperIdentifiers)
    .innerJoin(pages, eq(pages.id, paperIdentifiers.paperId))
    .where(and(eq(paperIdentifiers.scheme, first.scheme), eq(paperIdentifiers.value, first.value)));
  return [...paths, ...rows.map((row) => `/s/${row.shortId}`)];
}

/** The same for a page of any kind: a paper's at each of its addresses, any other at its address. */
export async function refreshPages(address: PageAddress, identifiers: readonly PaperId[] = []): Promise<void> {
  await refreshPaths(address.kind === 'paper' ? await paperPaths(getDb(), identifiers) : [pagePath(address)]);
}

/** The same for pages by id, of any kind: what a commit elsewhere changed, such as the links to them. */
export async function refreshPageIds(db: Reader, ids: Iterable<string>): Promise<void> {
  const paths: string[] = [];
  for (const id of new Set(ids)) {
    const page = await pageOf(db, id);
    if (!page) continue;
    if (page.kind !== 'paper') {
      paths.push(pagePath({ kind: page.kind, key: page.key }));
      continue;
    }
    const identifiers = await db
      .select({ scheme: paperIdentifiers.scheme, value: paperIdentifiers.value })
      .from(paperIdentifiers)
      .where(eq(paperIdentifiers.paperId, id));
    const [row] = await db.select({ shortId: pages.shortId }).from(pages).where(eq(pages.id, id));
    paths.push(...identifiers.map(paperPath), ...(row ? [`/s/${row.shortId}`] : []));
  }
  if (paths.length > 0) await refreshPaths(paths);
}

async function refreshPaths(paths: readonly string[]): Promise<void> {
  const outside: string[] = [];
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch {
      outside.push(path);
    }
  }
  if (outside.length) await revalidateInApp(outside);
  const token = process.env.CLOUDFLARE_PURGE_TOKEN;
  const zone = process.env.CLOUDFLARE_ZONE_ID;
  if (!token || !zone) return;
  const files = paths.map((path) => `${siteUrl()}${path}`);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error('edge purge', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('edge purge', err);
  }
}
