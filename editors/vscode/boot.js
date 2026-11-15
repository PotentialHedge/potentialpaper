// Starts VS Code for the Web on the page repo (src/editors/vscode/workbench.ts writes the configuration into the
// page). The web build exposes the workbench's `create()`; this is the embedder's part, as the build leaves it
// to whoever hosts it. Copied next to the build by scripts/build-editor-extension.mjs.
import { create, URI } from './out/vs/workbench/workbench.web.main.internal.js';

const element = document.getElementById('vscode-workbench-web-configuration');
const config = JSON.parse(element.getAttribute('data-settings'));
const workspace = { folderUri: URI.revive(config.folderUri) };

create(document.body, {
  ...config,
  workspaceProvider: {
    workspace,
    trusted: true,
    // One folder per frame: the page repo. Opening anything else isn't offered.
    open: async () => false,
  },
});
