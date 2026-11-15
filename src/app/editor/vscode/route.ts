import { editorCsp } from '@/editors/vscode/csp';
import { workbenchHtml } from '@/editors/vscode/workbench';
import { canonicalPaperId, PAPER_SCHEMES, parsePaperId, type PaperScheme } from '@/lib/paper-ids';
import { findPaper } from '@/server/papers';

export const dynamic = 'force-dynamic';

/**
 * VS Code for the Web, for one paper (`src/editors/vscode`), framed by the paper's `/code/…` page. Its own
 * CSP (`next.config.ts` leaves `/editor/` out of the site's): VS Code runs workers from `blob:`, frames its
 * extension host from this origin and webviews from their own, and is framed by this origin only.
 */
export async function GET(req: Request) {
  const query = new URL(req.url).searchParams;
  const scheme = PAPER_SCHEMES.find((s) => s === query.get('scheme')) as PaperScheme | undefined;
  const id = scheme && parsePaperId(scheme, query.get('value') ?? '');
  const found = id && (await findPaper(id));
  if (!found) return new Response('no such paper', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const canonical = canonicalPaperId(found.identifiers) ?? id;
  return new Response(workbenchHtml({ ...canonical, title: found.paper.title }), {
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
