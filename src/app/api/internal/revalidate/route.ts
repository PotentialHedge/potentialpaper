import { revalidatePath } from 'next/cache';
import { isInternalRequest } from '@/server/internal';
import { warmSoon } from '@/server/pages/warm';

export const dynamic = 'force-dynamic';

/**
 * Paper pages only, at an identifier's address (`proxy.ts`'s `PAPER_PATH`) or the short one (`/s/<n>`): all the
 * outside processes ever need to refresh.
 */
const PAPER_PATH = /^\/((abs|doi|openreview)\/[^?#]{1,1000}|s\/\d{1,12})$/;
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Revalidates paper pages for a process outside Next (`server/internal.ts`): the SSH server after a push, and
 * scripts that commit. `revalidatePath` only works inside a Next request, so they ask here.
 */
export async function POST(req: Request) {
  if (!isInternalRequest(req)) return new Response('Not found\n', { status: 404, headers: NO_STORE });
  const body = (await req.json().catch(() => null)) as { paths?: unknown } | null;
  const paths = body?.paths;
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > 20 ||
    !paths.every((p) => typeof p === 'string' && PAPER_PATH.test(p))
  ) {
    return Response.json({ error: 'paths: 1 to 20 paper paths' }, { status: 400, headers: NO_STORE });
  }
  for (const path of paths) revalidatePath(path);
  warmSoon(paths);
  return Response.json({ status: 'ok' }, { headers: NO_STORE });
}
