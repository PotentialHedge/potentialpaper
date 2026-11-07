import { revalidatePath } from 'next/cache';
import { paperPath, type PaperId } from '@/lib/paper-ids';
import { siteUrl } from '../site';

/**
 * After a commit, makes the paper's pages show it: Next renders them again on their next request, and
 * Cloudflare drops its copies when production has a purge token (TODO.md). Never fails the commit, which
 * has happened by now.
 */
export async function refreshPaperPages(identifiers: readonly PaperId[]): Promise<void> {
  const paths = identifiers.map(paperPath);
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (err) {
      // Outside a request, as in scripts and tests, there is no Next cache to clear.
      if (process.env.NODE_ENV === 'production') console.error('revalidate', path, err);
    }
  }
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
