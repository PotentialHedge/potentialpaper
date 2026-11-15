import type { WebEditor } from '../types';

/**
 * VS Code for the Web, built from the MIT-licensed sources (`editors/vscode/`), with the site's own extension
 * (`editors/vscode/extension/`), which speaks the workspace API.
 */
export const VSCODE_VERSION = '1.145.3';

/** Where the build is served from (`scripts/build-web-editor.sh` puts it in `public/` there). */
export const VSCODE_BASE = `/editor/vscode/${VSCODE_VERSION}`;

export const vscodeEditor: WebEditor = {
  id: 'vscode',
  name: 'VS Code',
  frameSrc: ({ scheme, value }) => `/editor/vscode?${new URLSearchParams({ scheme, value })}`,
};
