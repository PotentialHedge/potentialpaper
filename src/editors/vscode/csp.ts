import { CONTENT_ORIGIN, CONTENT_SOURCE } from '../../lib/demos';
import { siteFramers } from '../../server/site';
import { VSCODE_BASE } from './index';

/**
 * The content security policy of the editor's frame and files, in place of the site's (`next.config.ts`):
 * VS Code runs workers from `blob:`, frames its extension host from this origin and its webviews from an origin
 * each, and is framed by this origin only. Relative imports only, as `next.config.ts` imports it.
 */

/** Where a webview's own pages are, under the build (`VSCODE_BASE`). */
export const WEBVIEW_PRE_PATH = '/out/vs/workbench/contrib/webview/browser/pre/';

/**
 * Where webviews (the preview, the PDF viewer, image previews) are served from: a host each on the user content
 * domain (`lib/demos.ts`), `{{uuid}}` being one name per webview, which `proxy.ts` answers with these pages only.
 */
export function webviewTemplate(): string {
  return `${CONTENT_ORIGIN.replace('://', '://{{uuid}}.')}${VSCODE_BASE}${WEBVIEW_PRE_PATH}`;
}

/**
 * The policy of a webview's own pages, served on the webview's origin: the workbench frames them from the site, and
 * each frames its content from its own origin. The content (an extension's page) brings its own policy, and its
 * resources come through the webview's service worker, so nothing else is limited here: the editor's policy would
 * refuse them, and `'self'` on that origin would refuse the site framing them.
 */
export function webviewCsp(): string {
  return `frame-ancestors ${siteFramers()} ${CONTENT_SOURCE}`;
}

export function editorCsp(): string {
  const media = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${new URL(media).origin}`,
    `frame-src 'self' ${CONTENT_SOURCE}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
