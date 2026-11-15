import * as vscode from 'vscode';
import { sectionFormat, type SectionFormat } from './paths';

export { sectionFormat, type SectionFormat };

/**
 * Where a file sits in a page repo, wherever the repo is: the site's own folder in the browser
 * (`potentialpaper://page/`), or a `git clone` opened in VS Code on the desktop, which is a folder with the page's
 * `prek.toml` (`src/server/pages/starter.ts`) at its root.
 */

export const SCHEME = 'potentialpaper';

export interface PageFile {
  /** The repo's root folder. */
  root: vscode.Uri;
  /** The file's path in the repo, `community/10-summary.md`. */
  path: string;
}

/** The workspace folders that are page repos (`prek.toml` at the root), found once and when folders change. */
export class PageRepos implements vscode.Disposable {
  private roots: vscode.Uri[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh());
  }

  async refresh(): Promise<void> {
    const found: vscode.Uri[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme === SCHEME) {
        found.push(folder.uri);
        continue;
      }
      try {
        const text = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'prek.toml')),
        );
        if (/\/schemas\/|potentialpaper/i.test(text)) found.push(folder.uri);
      } catch {
        // Not a page repo.
      }
    }
    this.roots = found;
    void vscode.commands.executeCommand('setContext', 'potentialpaper.pageRepo', found.length > 0);
    this.changed.fire();
  }

  get any(): boolean {
    return this.roots.length > 0;
  }

  /** The page file at this address, if it is in one of the page repos. */
  fileOf(uri: vscode.Uri): PageFile | null {
    if (uri.scheme === SCHEME) {
      return { root: uri.with({ path: '/' }), path: uri.path.replace(/^\/+/, '').replace(/\/+$/, '') };
    }
    for (const root of this.roots) {
      const base = root.path.endsWith('/') ? root.path : `${root.path}/`;
      if (uri.scheme === root.scheme && uri.authority === root.authority && uri.path.startsWith(base)) {
        return { root, path: uri.path.slice(base.length) };
      }
    }
    return null;
  }

  rootOf(uri: vscode.Uri | undefined): vscode.Uri | null {
    if (uri) {
      const file = this.fileOf(uri);
      if (file) return file.root;
    }
    return this.roots[0] ?? null;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
