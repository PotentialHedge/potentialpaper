import type { PaperId } from '@/lib/paper-ids';
import { siteUrl } from '@/server/site';
import { webviewTemplate } from './csp';
import { VSCODE_BASE } from './index';

/**
 * The page VS Code for the Web boots from, for one paper: the build's own `workbench.html`, with its
 * configuration. The page repo is the folder (`potentialpaper://page/`), served by the site's extension, which
 * is the one extension added to the build's own (no marketplace).
 */

function attribute(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function workbenchHtml(paper: PaperId & { title: string }): string {
  const site = siteUrl();
  const origin = new URL(site);
  const base = `${site}${VSCODE_BASE}`;
  const webview = webviewTemplate();
  const config = {
    folderUri: { scheme: 'potentialpaper', authority: 'page', path: '/' },
    additionalBuiltinExtensions: [
      { scheme: origin.protocol.slice(0, -1), authority: origin.host, path: `${VSCODE_BASE}/potentialpaper` },
    ],
    productConfiguration: {
      nameShort: 'PotentialPaper',
      nameLong: 'PotentialPaper Editor',
      enableTelemetry: false,
      // The Commit button in Source Control (the extension's `actionButton`), a proposed API.
      extensionEnabledApiProposals: { 'potentialpaper.potentialpaper': ['scmActionButton'] },
      ...(webview ? { webviewContentExternalBaseUrlTemplate: webview } : {}),
    },
    windowIndicator: { label: `$(book) ${paper.title.slice(0, 60)}`, tooltip: paper.title },
    configurationDefaults: {
      'potentialpaper.paper': { scheme: paper.scheme, value: paper.value },
      'potentialpaper.origin': site,
      // The section preview and the PDF viewer are webviews, which need an origin each (`csp.ts`). Where there is
      // none, the host page shows its own preview, and a PDF opens as VS Code shows any file it can't read.
      'potentialpaper.webviews': Boolean(webview),
      ...(webview ? {} : { 'workbench.editorAssociations': { '*.pdf': 'default' } }),
      'workbench.colorTheme': 'Default Light Modern',
      'workbench.startupEditor': 'none',
      'workbench.tips.enabled': false,
      'workbench.enableExperiments': false,
      'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
      'chat.disableAIFeatures': true,
      // A page editor, not a workbench for code: no chat sidebar, layout menu or debugging. The terminal,
      // debugging, extensions views and Accounts go at build time (editors/vscode/patch-vscode.mjs).
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.layoutControl.enabled': false,
      'debug.showInStatusBar': 'never',
      'debug.toolBarLocation': 'hidden',
      // Each JSON file is checked against its schema, which the extension carries (scripts/write-page-schemas.ts),
      // for errors, completion and hovers as people type. A commit is refused while one has an error.
      'json.schemaDownload.trustedDomains': { [`${site}/`]: true },
      // Saved changes are what Source Control lists and what a reload keeps, so save as people type.
      'files.autoSave': 'afterDelay',
      'files.insertFinalNewline': true,
      'files.trimFinalNewlines': true,
      'files.trimTrailingWhitespace': true,
      // Sections are formatted with Prettier, as `prek.toml` formats them (the extension's `precommit.ts`).
      '[markdown]': {
        'editor.wordWrap': 'on',
        'editor.defaultFormatter': 'potentialpaper.potentialpaper',
        'files.trimTrailingWhitespace': false,
      },
      '[html]': { 'editor.wordWrap': 'on' },
    },
  };
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
    <meta name="robots" content="noindex, nofollow">
    <meta id="vscode-workbench-web-configuration" data-settings="${attribute(config)}">
    <meta id="vscode-workbench-web-base-url" data-settings="${VSCODE_BASE}">
    <link rel="stylesheet" href="${base}/out/vs/workbench/workbench.web.main.internal.css">
    <title>Edit · PotentialPaper</title>
  </head>
  <body aria-label=""></body>
  <script>
    globalThis._VSCODE_FILE_ROOT = new URL(${JSON.stringify(`${VSCODE_BASE}/out/`)}, window.location.origin).toString();
  </script>
  <script src="${base}/out/nls.messages.js"></script>
  <script type="module" src="${base}/boot.js"></script>
</html>
`;
}
