// Trims VS Code for the Web down to an editor for page repos, before it is built (the Dockerfile's `vscode`
// stage runs this in the VS Code checkout). Only the UI goes: the services stay registered, since much of the
// workbench asks for them, so nothing else breaks. Each patch fails the build if its text isn't there, so a new
// VS Code version can't silently undo one. Settings do the rest (src/editors/vscode/workbench.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? '.';

/** Built-in extensions a page repo has no use for: sign-in, notebooks, npm, a browser, prompt files. */
const DROPPED_EXTENSIONS = [
  'github-authentication',
  'microsoft-authentication',
  'ipynb',
  'notebook-renderers',
  'npm',
  'simple-browser',
  'prompt-basics',
];

/** Views never shown in the activity bar or the panel: debugging, the terminal, ports, remotes, extensions. */
const HIDDEN_CONTAINERS = [
  'workbench.view.debug',
  'workbench.panel.repl',
  'terminal',
  '~remote.forwardedPortsContainer',
  'workbench.view.remote',
  'workbench.view.extensions',
];

/** Top-level menus left out of the menu bar. */
const HIDDEN_MENUS = ['Run', 'Terminal'];

function patch(file, from, to) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`patch-vscode: ${file} no longer has ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

patch(
  'src/vs/workbench/browser/parts/paneCompositeBar.ts',
  'const viewContainerId = isString(viewContainerOrId) ? viewContainerOrId : viewContainerOrId.id;\n',
  'const viewContainerId = isString(viewContainerOrId) ? viewContainerOrId : viewContainerOrId.id;\n' +
    `\t\tif (${JSON.stringify(HIDDEN_CONTAINERS)}.includes(viewContainerId)) { return true; }\n`,
);

patch(
  'src/vs/workbench/browser/parts/titlebar/menubarControl.ts',
  "if (mainMenuAction instanceof SubmenuItemAction && typeof mainMenuAction.item.title !== 'string') {",
  "if (mainMenuAction instanceof SubmenuItemAction && typeof mainMenuAction.item.title !== 'string' && " +
    `!${JSON.stringify(HIDDEN_MENUS)}.includes(mainMenuAction.item.title.original)) {`,
);

// Accounts hidden in the activity bar unless someone turns it back on. Kept in the browser's storage, not a
// setting, so only its default can be changed.
patch(
  'src/vs/workbench/browser/parts/globalCompositeBar.ts',
  'return storageService.getBoolean(AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY, StorageScope.PROFILE, true);',
  'return storageService.getBoolean(AccountsActivityActionViewItem.ACCOUNTS_VISIBILITY_PREFERENCE_KEY, StorageScope.PROFILE, false);',
);

// Left out when the built-in extensions are packaged (they are still compiled, which the build insists on).
patch(
  'build/lib/extensions.ts',
  'const excludedExtensions = [\n',
  `const excludedExtensions = [\n${DROPPED_EXTENSIONS.map((name) => `\t'${name}',\n`).join('')}`,
);
console.log('patch-vscode: done');
