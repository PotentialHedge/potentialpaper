import { CONTENT_HOSTNAME, CONTENT_ORIGIN, isContentHost } from '../demos';

/**
 * Where plugins are served (DESIGN.md §10): each on an origin of its own under the content domain,
 * `<label>.<content domain>/<commit>/…`, where the label is a stable hash of the plugin id
 * (`server/plugins/serve.ts` makes it). A plugin keeps that origin, and so its own storage, across versions, and no
 * plugin can reach another's, a demo's or the app's. The SDK is served from the content domain itself.
 */

const content = new URL(CONTENT_ORIGIN);

/** A plugin host's label: `plugin-` and 20 hex digits, never a demo's (32 hex) or a webview's (a uuid). */
export const PLUGIN_HOST_LABEL = /^plugin-[0-9a-f]{20}$/;

/** The label of a plugin's host, or `null` for any other host. */
export function pluginHostOf(hostname: string): string | null {
  if (!isContentHost(hostname)) return null;
  const label = hostname.slice(0, -CONTENT_HOSTNAME.length - 1);
  return PLUGIN_HOST_LABEL.test(label) ? label : null;
}

export function pluginOrigin(label: string): string {
  return `${content.protocol}//${label}.${content.host}`;
}

/** A plugin's files at a commit: `<origin>/<commit>/`. */
export function pluginBaseUrl(label: string, commit: string): string {
  return `${pluginOrigin(label)}/${commit}/`;
}

/** The SDK's folder, as a CSP source, and the SDK itself: one file, no build step needed to use it. */
export const SDK_BASE = `${content.protocol}//${content.host}/sdk/`;
export const SDK_URL = `${SDK_BASE}v1/pp.js`;
