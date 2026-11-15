import { siteUrl } from '../../server/site';
import { VSCODE_BASE } from './index';

/**
 * The content security policy of the editor's frame and files, in place of the site's (`next.config.ts`):
 * VS Code runs workers from `blob:`, frames its extension host from this origin and its webviews from an origin
 * each, and is framed by this origin only. Relative imports only, as `next.config.ts` imports it.
 */

/** Where webviews (Markdown and image previews) are served from, `{{uuid}}` being one name per webview. */
export function webviewTemplate(): string | undefined {
  const configured = process.env.WEB_EDITOR_WEBVIEW_URL;
  if (configured) return configured;
  const origin = new URL(siteUrl());
  // Browsers resolve every name under `localhost` to this machine, so in development each webview gets one.
  if (origin.hostname === 'localhost') {
    return `${origin.protocol}//{{uuid}}.localhost${origin.port ? `:${origin.port}` : ''}${VSCODE_BASE}/out/vs/workbench/contrib/webview/browser/pre/`;
  }
  return undefined;
}

function webviewSource(): string | null {
  const template = webviewTemplate();
  if (!template) return null;
  const url = new URL(template.replace('{{uuid}}', 'x'));
  return `${url.protocol}//*.${url.host.replace(/^x\./, '')}`;
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
