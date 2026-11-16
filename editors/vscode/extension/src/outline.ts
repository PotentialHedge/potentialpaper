import * as vscode from 'vscode';
import type { PageRepos } from './page';

/**
 * The Page view in the explorer: what shows around a paper's title besides its sections, the links under it and its
 * picture, with a way to add each where a page has none, so nobody has to know the files' names first. Works on the
 * page repo wherever it is, in the browser or a clone.
 */

const PICTURE = /^thumbnail\.(png|jpg|jpeg|gif|webp|avif)$/;

type Item =
  | { kind: 'group'; name: 'links' | 'picture'; count: number }
  | { kind: 'file'; uri: vscode.Uri; label: string; description?: string; icon: string }
  | { kind: 'action'; label: string; description?: string; tooltip: string; icon: string; command: vscode.Command }
  | { kind: 'note'; label: string; tooltip: string };

interface Link {
  uri: vscode.Uri;
  label: string;
  url: string;
}

export class PageView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private watcher: vscode.Disposable | undefined;

  /** `denied`: why the viewer can't write a path, `null` if they can (the browser's; a clone can write anything). */
  constructor(
    private readonly repos: PageRepos,
    private readonly denied: (path: string) => string | null = () => null,
  ) {
    const touches = (uris: readonly vscode.Uri[]) => uris.some((uri) => this.repos.fileOf(uri));
    this.subscriptions.push(
      vscode.window.registerTreeDataProvider('potentialpaper.page', this),
      repos.onDidChange(() => {
        this.watch();
        this.refresh();
      }),
      vscode.workspace.onDidCreateFiles((e) => touches(e.files) && this.refresh()),
      vscode.workspace.onDidDeleteFiles((e) => touches(e.files) && this.refresh()),
      vscode.workspace.onDidRenameFiles((e) => touches(e.files.map((f) => f.newUri)) && this.refresh()),
      vscode.workspace.onDidSaveTextDocument((d) => touches([d.uri]) && this.refresh()),
    );
  }

  /** In a clone, files also change outside VS Code (a pull, a checkout). */
  private watch(): void {
    this.watcher?.dispose();
    const root = this.repos.rootOf(undefined);
    if (!root || root.scheme !== 'file') return;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '{links/*.json,thumbnail.*}'),
    );
    watcher.onDidCreate(() => this.refresh());
    watcher.onDidChange(() => this.refresh());
    watcher.onDidDelete(() => this.refresh());
    this.watcher = watcher;
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  private async names(dir: vscode.Uri): Promise<string[]> {
    try {
      return (await vscode.workspace.fs.readDirectory(dir))
        .filter(([, type]) => type === vscode.FileType.File)
        .map(([name]) => name)
        .sort();
    } catch {
      return [];
    }
  }

  private async links(root: vscode.Uri): Promise<Link[]> {
    const dir = vscode.Uri.joinPath(root, 'links');
    const links: Link[] = [];
    for (const name of (await this.names(dir)).filter((n) => n.endsWith('.json'))) {
      const uri = vscode.Uri.joinPath(dir, name);
      try {
        const value = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as {
          label?: unknown;
          url?: unknown;
        };
        links.push({
          uri,
          label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : name,
          url: typeof value.url === 'string' ? value.url : '',
        });
      } catch {
        links.push({ uri, label: name, url: 'not a link yet: check the file' });
      }
    }
    return links;
  }

  async getChildren(item?: Item): Promise<Item[]> {
    const root = this.repos.rootOf(undefined);
    if (!root) return [];
    if (!item) {
      const files = await this.names(root);
      return [
        { kind: 'group', name: 'links', count: (await this.links(root)).length },
        {
          kind: 'group',
          name: 'picture',
          count: files.filter((n) => PICTURE.test(n) || n === 'thumbnail.json').length,
        },
      ];
    }
    if (item.kind !== 'group') return [];
    if (item.name === 'links') {
      const links = await this.links(root);
      const items: Item[] = links.map((link) => ({
        kind: 'file',
        uri: link.uri,
        label: link.label,
        description: link.url,
        icon: 'link',
      }));
      const reason = this.denied('links/10-new.json');
      if (reason) {
        items.push({ kind: 'note', label: 'You can’t add links here', tooltip: reason });
      } else {
        items.push({
          kind: 'action',
          label: 'Add a link…',
          description: links.length === 0 ? 'code, a project page, a video, slides' : undefined,
          tooltip:
            'A link under the paper’s title: a file in links/ with a label and an address. One named like a built-in link (arXiv, PDF, OpenReview, DOI, Scholar) replaces it.',
          icon: 'add',
          command: { command: 'potentialpaper.newLink', title: 'New Link', arguments: [root] },
        });
      }
      return items;
    }
    const files = await this.names(root);
    const items: Item[] = files
      .filter((n) => PICTURE.test(n) || n === 'thumbnail.json')
      .map((name) => ({
        kind: 'file',
        uri: vscode.Uri.joinPath(root, name),
        label: name,
        description: name === 'thumbnail.json' ? 'its alt text and caption' : 'the picture',
        icon: name === 'thumbnail.json' ? 'json' : 'file-media',
      }));
    const reason = this.denied('thumbnail.json');
    if (reason) {
      if (items.length === 0) items.push({ kind: 'note', label: 'You can’t add a picture here', tooltip: reason });
    } else if (!files.some((n) => PICTURE.test(n))) {
      items.push({
        kind: 'action',
        label: 'Add a picture…',
        description: 'shown on the paper’s card',
        tooltip: 'Drag a picture into the explorer, named thumbnail.png (or .jpg, .gif, .webp, .avif).',
        icon: 'add',
        command: { command: 'potentialpaper.addPicture', title: 'Add a Picture', arguments: [root] },
      });
    }
    return items;
  }

  getTreeItem(item: Item): vscode.TreeItem {
    if (item.kind === 'group') {
      const tree = new vscode.TreeItem(
        item.name === 'links' ? 'Links under the title' : 'Picture',
        // Open where the page has none, so the way to add one shows.
        item.count === 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
      );
      tree.description = item.count === 0 ? 'none yet' : item.name === 'links' ? String(item.count) : undefined;
      tree.iconPath = new vscode.ThemeIcon(item.name === 'links' ? 'link' : 'file-media');
      tree.id = item.name;
      return tree;
    }
    if (item.kind === 'file') {
      const tree = new vscode.TreeItem(item.label);
      tree.description = item.description;
      tree.tooltip = item.uri.path;
      tree.resourceUri = item.uri;
      tree.iconPath = new vscode.ThemeIcon(item.icon);
      tree.command = { command: 'vscode.open', title: 'Open', arguments: [item.uri] };
      return tree;
    }
    if (item.kind === 'action') {
      const tree = new vscode.TreeItem(item.label);
      tree.description = item.description;
      tree.tooltip = item.tooltip;
      tree.iconPath = new vscode.ThemeIcon(item.icon);
      tree.command = item.command;
      return tree;
    }
    const tree = new vscode.TreeItem(item.label);
    tree.tooltip = item.tooltip;
    tree.description = item.tooltip;
    tree.iconPath = new vscode.ThemeIcon('lock');
    return tree;
  }

  dispose(): void {
    this.watcher?.dispose();
    for (const s of this.subscriptions) s.dispose();
    this.emitter.dispose();
  }
}

/** Where the picture goes: a file the explorer takes by dragging, and its words beside it. */
export async function addPicture(root: vscode.Uri): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    'Drag a picture from your computer into the explorer and name it thumbnail.png (or .jpg, .gif, .webp, .avif). Its alt text and caption go in thumbnail.json beside it.',
    'Write thumbnail.json',
  );
  if (!pick) return;
  const uri = vscode.Uri.joinPath(root, 'thumbnail.json');
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('{\n  "alt": "",\n  "caption": ""\n}\n'));
  }
  await vscode.window.showTextDocument(uri);
}
