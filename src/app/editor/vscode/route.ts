import { editorCsp } from '@/editors/vscode/csp';
import { workbenchHtml } from '@/editors/vscode/workbench';
import { addressOfRef, pageRefOf } from '@/lib/kinds';
import { namedPage } from '@/server/pages/named';

export const dynamic = 'force-dynamic';

/**
 * VS Code for the Web, for one page of any kind (`src/editors/vscode`), framed by its `/code/…` page. Its own
 * CSP (`next.config.ts` leaves `/editor/` out of the site's): VS Code runs workers from `blob:`, frames its
 * extension host from this origin and webviews from their own, and is framed by this origin only.
 */
export async function GET(req: Request) {
  const query = new URL(req.url).searchParams;
  const asked = addressOfRef({ scheme: query.get('scheme') ?? '', value: query.get('value') ?? '' });
  const found = asked && (await namedPage(asked));
  if (!found) return new Response('no such page', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  return new Response(workbenchHtml({ ...pageRefOf(found.address), title: found.name }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': editorCsp(),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}
