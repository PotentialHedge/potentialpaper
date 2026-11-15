import { siteUrl } from '../../server/site';
import { VSCODE_BASE } from './index';

/**
 * The content security policy of the editor's frame and files, in place of the site's (`next.config.ts`):
 * VS Code runs workers from `blob:`, frames its extension host from this origin and its webviews from an origin
 * each, and is framed by this origin only. Relative imports only, as `next.config.ts` imports it.
 */

/** Where a webview's own pages are, under the build (`VSCODE_BASE`). */
export const WEBVIEW_PRE_PATH = '/out/vs/workbench/contrib/webview/browser/pre/';

/** Where webviews (Markdown and image previews) are served from, `{{uuid}}` being one name per webview. */
export function webviewTemplate(): string | undefined {
  const configured = process.env.WEB_EDITOR_WEBVIEW_URL;
  if (configured) return configured;
  const origin = new URL(siteUrl());
  // Browsers resolve every name under `localhost` to this machine, so in development each webview gets one. Not in
  // a production build, whose headers are fixed at build time, when `APP_URL` may not be set yet.
  if (origin.hostname === 'localhost' && process.env.NODE_ENV !== 'production') {
    return `${origin.protocol}//{{uuid}}.localhost${origin.port ? `:${origin.port}` : ''}${VSCODE_BASE}${WEBVIEW_PRE_PATH}`;
  }
  return undefined;
}

function webviewSource(): string | null {
  const template = webviewTemplate();
  if (!template) return null;
  const url = new URL(template.replace('{{uuid}}', 'x'));
  return `${url.protocol}//*.${url.host.replace(/^x\./, '')}`;
}

/**
 * The policy of a webview's own pages, served on the webview's origin: the workbench frames them from the site, and
 * each frames its content from its own origin. The content (an extension's page) brings its own policy, and its
 * resources come through the webview's service worker, so nothing else is limited here: the editor's policy would
 * refuse them, and `'self'` on that origin would refuse the site framing them.
 */
export function webviewCsp(): string {
  const webview = webviewSource();
  return `frame-ancestors ${new URL(siteUrl()).origin}${webview ? ` ${webview}` : ''}`;
}

export function editorCsp(): string {
  const webview = webviewSource();
  const media = process.env.PDF_BASE_URL ?? 'https://pdfs.potentialhedge.com';
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${new URL(media).origin}`,
    `frame-src 'self'${webview ? ` ${webview}` : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}
