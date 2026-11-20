import * as vscode from 'vscode';
import { Api, ApiError, type PaperRef } from './api';
import { PageRepos, SCHEME } from './page';
import { addPicture, PageView } from './outline';
import { PdfViewer } from './pdf';
import { checksOn, firstError, formatted, markdownFormatter } from './precommit';
import { Preview } from './preview';
import { Site } from './site';
import { ORIGINAL_SCHEME, Store } from './store';

/**
 * PotentialPaper in VS Code (`docs/web-editor.md`). Wherever a page repo is open, in the browser or a clone on the
 * desktop: a preview of each section as the page shows it (`preview.ts`), a PDF viewer (`pdf.ts`), the JSON files
 * checked against their schemas (the manifest's `jsonValidation`) and sections formatted as `prek.toml` formats
 * them. In VS Code for the Web on the site, also the page repo as a folder, its uncommitted changes in Source
 * Control, and a commit that goes to the site. The host page around it hears what is open through a
 * `BroadcastChannel` (`channel` below), and shows its own preview where webviews can't open.
 */

const ROOT = vscode.Uri.from({ scheme: SCHEME, authority: 'page', path: '/' });

function pathOf(uri: vscode.Uri): string {
  return uri.path.replace(/^\/+/, '').replace(/\/+$/, '');
}

function uriOf(path: string): vscode.Uri {
  return ROOT.with({ path: `/${path}` });
}

function originalUri(path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: ORIGINAL_SCHEME, authority: 'page', path: `/${path}` });
}

/** VS Code's `scmActionButton` API, not in `@types/vscode` as it isn't final. */
interface ActionButton {
  command: vscode.Command & { shortTitle?: string };
  enabled: boolean;
}

/** What goes to the host page: the open file, for its preview, and commits, for its links. Same-origin only. */
type HostMessage =
  | { type: 'ready'; previews: boolean }
  | { type: 'active'; path: string | null; text: string | null }
  | { type: 'committed'; head: string | null };

/** Each path and the folders above it: what the explorer has been told exists. */
function withFolders(paths: string[]): Set<string> {
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join('/'));
  }
  return all;
}

class FileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private known = new Set<string>();

  /**
   * `loaded` settles once the page's files are in (or failed to come): VS Code asks for the folder and the files it
   * had open as soon as the extension starts, and an answer from before then would be an empty folder it keeps.
   */
  constructor(
    private readonly store: Store,
    private readonly loaded: Promise<unknown>,
  ) {
    // A path the explorer hasn't been told of is new, or it ignores it (a change to something it doesn't have).
    store.onDidChange((paths) => {
      const now = withFolders(store.paths());
      const events: vscode.FileChangeEvent[] = [];
      for (const path of withFolders(paths)) {
        const type = !now.has(path)
          ? vscode.FileChangeType.Deleted
          : this.known.has(path)
            ? vscode.FileChangeType.Changed
            : vscode.FileChangeType.Created;
        if (type !== vscode.FileChangeType.Changed || paths.includes(path)) events.push({ type, uri: uriOf(path) });
      }
      this.known = now;
      this.emitter.fire(events);
    });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    await this.loaded;
    const path = pathOf(uri);
    if (this.store.exists(path)) {
      const reason = this.store.readonlyReason(path);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: this.store.mtime(path),
        size: this.store.remoteOf(path)?.lfs?.bytes ?? 0,
        permissions: reason ? vscode.FilePermission.Readonly : undefined,
      };
    }
    if (this.store.isDir(path)) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    await this.loaded;
    const path = pathOf(uri);
    if (!this.store.isDir(path)) throw vscode.FileSystemError.FileNotADirectory(uri);
    return this.store.children(path);
  }

  createDirectory(uri: vscode.Uri): void {
    this.store.mkdir(pathOf(uri));
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    await this.loaded;
    return this.store.read(pathOf(uri));
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): Promise<void> {
    const path = pathOf(uri);
    const exists = this.store.exists(path);
    if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (exists && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    await this.store.write(path, content);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const path = pathOf(uri);
    if (this.store.exists(path)) return this.store.delete(path);
    if (!this.store.isDir(path)) throw vscode.FileSystemError.FileNotFound(uri);
    const inside = this.store.paths().filter((p) => p.startsWith(`${path}/`));
    if (inside.length > 0 && !options.recursive) throw vscode.FileSystemError.NoPermissions('the folder is not empty');
    for (const p of inside) await this.store.delete(p);
    this.store.removeDir(path);
  }

  /** A move is the file written at its new path and deleted at its old one, as git sees it too. */
  async rename(from: vscode.Uri, to: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const source = pathOf(from);
    const target = pathOf(to);
    const files = this.store.exists(source)
      ? [[source, target]]
      : this.store
          .paths()
          .filter((p) => p.startsWith(`${source}/`))
          .map((p) => [p, `${target}${p.slice(source.length)}`]);
    for (const [, t] of files) {
      if (this.store.exists(t) && !options.overwrite) throw vscode.FileSystemError.FileExists(uriOf(t));
    }
    for (const [s, t] of files) {
      await this.store.write(t, await this.store.read(s));
      await this.store.delete(s);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Sign in on the site to commit, then try again.';
    return err.message.charAt(0).toUpperCase() + err.message.slice(1);
  }
  return err instanceof Error ? err.message : String(err);
}

/** What works in any page repo, in the browser or on the desktop. */
async function activateAnywhere(
  context: vscode.ExtensionContext,
  previews: boolean,
  denied?: (path: string) => string | null,
): Promise<{ repos: PageRepos; view: PageView }> {
  const repos = new PageRepos();
  const view = new PageView(repos, denied);
  const site = new Site(context.secrets);
  context.subscriptions.push(repos, view);
  void vscode.commands.executeCommand('setContext', 'potentialpaper.webviews', previews);

  if (previews) {
    const preview = new Preview(context.extensionUri, repos, site);
    context.subscriptions.push(
      preview,
      vscode.commands.registerCommand('potentialpaper.showPreview', (uri?: vscode.Uri) => {
        const editor =
          uri && vscode.window.activeTextEditor?.document.uri.toString() !== uri.toString()
            ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString())
            : vscode.window.activeTextEditor;
        preview.show(editor);
      }),
      PdfViewer.register(context),
    );
  }

  const rootFor = async (uri?: vscode.Uri) => {
    const root = repos.rootOf(uri ?? vscode.window.activeTextEditor?.document.uri);
    if (!root) void vscode.window.showInformationMessage('Open a page repo (a clone of a page from the site) first.');
    return root;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('potentialpaper.signIn', async () => {
      const root = await rootFor();
      const origin = root && (await site.originOf(root));
      if (origin && (await site.signIn(origin))) void vscode.window.showInformationMessage(`Signed in to ${origin}.`);
    }),
    vscode.commands.registerCommand('potentialpaper.signOut', async () => {
      const root = await rootFor();
      const origin = root && (await site.originOf(root));
      if (origin) await site.signOut(origin);
    }),
    vscode.commands.registerCommand('potentialpaper.newLink', async (folder?: vscode.Uri) => {
      const root = await rootFor(folder);
      if (root) await newLink(root);
    }),
    vscode.commands.registerCommand('potentialpaper.addPicture', async (folder?: vscode.Uri) => {
      const root = await rootFor(folder);
      if (root) await addPicture(root);
    }),
  );

  // Sections formatted as `prek.toml` formats them, in clones too (the browser's are registered with its folder).
  let formatters: vscode.Disposable | undefined;
  repos.onDidChange(() => {
    formatters?.dispose();
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .map((f) => f.uri)
      .filter((uri) => uri.scheme !== SCHEME && repos.fileOf(vscode.Uri.joinPath(uri, 'prek.toml')));
    formatters = vscode.Disposable.from(
      ...roots.map((root) =>
        vscode.languages.registerDocumentFormattingEditProvider(
          { language: 'markdown', pattern: new vscode.RelativePattern(root, '{owners,community}/*.md') },
          markdownFormatter(),
        ),
      ),
    );
  });
  context.subscriptions.push({ dispose: () => formatters?.dispose() });
  return { repos, view };
}

/** A link under the paper's title: `links/NN-<slug>.json`, after the others. */
async function newLink(root: vscode.Uri): Promise<void> {
  const label = await vscode.window.showInputBox({
    prompt: 'What the link says under the title',
    placeHolder: 'Code',
    validateInput: (v) =>
      v.trim().length === 0 || v.trim().length > 30 || /[[\]]/.test(v) ? '1 to 30 characters, no brackets' : null,
  });
  if (!label) return;
  const url = await vscode.window.showInputBox({
    prompt: 'Where it goes',
    placeHolder: 'https://github.com/…',
    validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? null : 'An http or https address'),
  });
  if (!url) return;
  const dir = vscode.Uri.joinPath(root, 'links');
  let names: string[] = [];
  try {
    names = (await vscode.workspace.fs.readDirectory(dir)).map(([name]) => name);
  } catch {
    // No links yet.
  }
  const taken = names.map((n) => Number(n.slice(0, 2))).filter(Number.isFinite);
  const order = Math.min(99, Math.floor(Math.max(0, ...taken) / 10) * 10 + 10);
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'link';
  const uri = vscode.Uri.joinPath(dir, `${String(order).padStart(2, '0')}-${slug}.json`);
  const text = `${JSON.stringify({ label: label.trim(), url: url.trim() }, null, 2)}\n`;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  await vscode.window.showTextDocument(uri);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('potentialpaper');
  const paper = config.get<PaperRef | null>('paper');
  const origin = config.get<string>('origin') || globalThis.location?.origin || '';
  const previews = config.get<boolean>('webviews', true);
  void vscode.commands.executeCommand('setContext', 'potentialpaper.inBrowser', Boolean(paper));
  if (!paper) {
    const { repos } = await activateAnywhere(context, previews);
    await repos.refresh();
    return;
  }

  const api = new Api(origin, paper);
  const store = new Store(api, context.workspaceState, `pending:${paper.scheme}:${paper.value}`);
  // Loading starts at once, so the file system can wait for it (`FileSystem`); its failure is shown below.
  const loading = store.load();
  const fs = new FileSystem(
    store,
    loading.catch(() => {}),
  );
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
      provideTextDocumentContent: (uri) => store.original(pathOf(uri)),
    }),
  );
  const { repos, view } = await activateAnywhere(context, previews, (path) => store.readonlyReason(path));
  store.onDidChange(() => view.refresh());

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(
      { scheme: SCHEME, language: 'markdown' },
      markdownFormatter(),
    ),
    // The terminal, debugging and extensions are hidden (editors/vscode/patch-vscode.mjs); their keys do nothing.
    vscode.commands.registerCommand('potentialpaper.nothing', () => {}),
  );

  const channel = new BroadcastChannel(`potentialpaper-editor:${paper.scheme}:${paper.value}`);
  const tell = (message: HostMessage) => channel.postMessage(message);

  // Source Control: the changes not yet committed, and the commit message.
  const scm = vscode.scm.createSourceControl('potentialpaper', 'Page', ROOT);
  scm.inputBox.placeholder = 'What you changed (Ctrl+Enter to commit). Add “Evidence: <url>” lines at the end.';
  scm.acceptInputCommand = { command: 'potentialpaper.commit', title: 'Commit' };
  scm.quickDiffProvider = {
    provideOriginalResource: (uri) => (uri.scheme === SCHEME ? originalUri(pathOf(uri)) : undefined),
  };
  const group = scm.createResourceGroup('changes', 'Changes');
  group.hideWhenEmpty = false;
  context.subscriptions.push(scm, { dispose: () => channel.close() });

  const refreshGroup = () => {
    group.resourceStates = store.changes().map(([path, p]) => {
      const deleted = p.content === null;
      const added = p.original === null;
      const conflict = store.conflicts().includes(path);
      return {
        resourceUri: uriOf(path),
        contextValue: 'change',
        decorations: {
          strikeThrough: deleted,
          tooltip: conflict ? 'Conflict: settle the marked lines' : deleted ? 'Deleted' : added ? 'Added' : 'Changed',
          faded: deleted,
        },
        command: { command: 'potentialpaper.openChange', title: 'Open Change', arguments: [path] },
      };
    });
    scm.count = group.resourceStates.length;
    // The Commit button under the message box (the `scmActionButton` API, which `workbench.ts` turns on).
    (scm as vscode.SourceControl & { actionButton?: ActionButton }).actionButton = {
      command: {
        command: 'potentialpaper.commit',
        title: scm.count > 0 ? '$(check) Commit to the page' : '$(check) Commit (nothing changed yet)',
        shortTitle: 'Commit',
      },
      enabled: scm.count > 0,
    };
  };
  store.onDidChange(refreshGroup);

  /** The page's checks over the changed files (`precommit.ts`): fixes written, the first error shown. */
  const runChecks = async (failed = 'Not committed'): Promise<boolean> => {
    for (const [path, p] of store.changes()) {
      if (p.content === null) continue;
      const out = await formatted(path, p.content);
      if (out !== null) await store.write(path, new TextEncoder().encode(out));
    }
    const files = store
      .changes()
      .filter(([, p]) => p.content !== null)
      .map(([path, p]) => ({ path, text: p.content!, added: p.original === null, uri: uriOf(path) }));
    const error = await firstError(files, store.paths());
    if (!error) return true;
    const where = error.range ? `${pathOf(error.uri)} line ${error.range.start.line + 1}: ` : '';
    const pick = await vscode.window.showWarningMessage(`${failed}: ${where}${error.message}`, 'Show');
    if (pick) await vscode.window.showTextDocument(error.uri, error.range ? { selection: error.range } : {});
    return false;
  };

  const commands: [string, (...args: never[]) => unknown][] = [
    [
      'potentialpaper.runChecks',
      async () => {
        if (store.changes().length === 0) {
          void vscode.window.showInformationMessage('There is nothing to check: save a change first.');
          return;
        }
        if (await runChecks('A check failed')) void vscode.window.showInformationMessage('The checks passed.');
      },
    ],
    [
      'potentialpaper.commit',
      async () => {
        if (store.changes().length === 0) {
          void vscode.window.showInformationMessage('There is nothing to commit: save a change first.');
          return;
        }
        if (vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.scheme === SCHEME)) {
          await vscode.workspace.saveAll(false);
        }
        const conflicts = store.conflicts();
        if (conflicts.length > 0) {
          void vscode.window.showWarningMessage(`Settle the conflict markers in ${conflicts.join(', ')} first.`);
          return;
        }
        // What `prek.toml` does before a commit in a clone, unless turned off: fix, then refuse while a file has an error.
        if (checksOn() && !(await runChecks())) return;
        const message = scm.inputBox.value.trim();
        if (!message) {
          void vscode.window.showWarningMessage('Say what you changed in the message box, then commit.');
          return;
        }
        try {
          const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.SourceControl, title: 'Committing' },
            () => store.commit(message),
          );
          scm.inputBox.value = '';
          tell({ type: 'committed', head: result.head });
          const pick = await vscode.window.showInformationMessage(
            result.changed ? 'Committed to the page.' : 'Nothing changed: the page already says that.',
            'Open the page',
          );
          if (pick) await vscode.commands.executeCommand('potentialpaper.openPage');
        } catch (err) {
          if (err instanceof ApiError && err.code === 'edit_conflict') {
            const conflicted = store.conflicts();
            void vscode.window.showWarningMessage(
              conflicted.length > 0
                ? `Someone changed the same lines meanwhile. Your changes are now on top of theirs: settle the marked lines in ${conflicted.join(', ')}, then commit again.`
                : 'Someone changed the page meanwhile. Your changes are merged on top: check them, then commit again.',
            );
            if (conflicted[0]) await vscode.window.showTextDocument(uriOf(conflicted[0]));
            return;
          }
          void vscode.window.showErrorMessage(`Not committed: ${describe(err)}`);
        }
      },
    ],
    [
      'potentialpaper.refresh',
      async () => {
        try {
          if (store.changes().length > 0 && store.baseOid !== null) {
            await store.load();
            if (store.head !== store.baseOid) {
              const conflicts = await store.rebase();
              if (conflicts.length > 0) {
                void vscode.window.showWarningMessage(
                  `Merged with the page's latest version. Settle the marked lines in ${conflicts.join(', ')}.`,
                );
              }
            }
          } else {
            await store.load();
          }
        } catch (err) {
          void vscode.window.showErrorMessage(describe(err));
        }
      },
    ],
    [
      'potentialpaper.discard',
      async (state: vscode.SourceControlResourceState) => {
        const path = pathOf(state.resourceUri);
        const pick = await vscode.window.showWarningMessage(
          `Discard your change to ${path}?`,
          { modal: true },
          'Discard',
        );
        if (pick) store.discard(path);
      },
    ],
    [
      'potentialpaper.discardAll',
      async () => {
        const pick = await vscode.window.showWarningMessage('Discard all your changes?', { modal: true }, 'Discard');
        if (pick) store.discardAll();
      },
    ],
    [
      'potentialpaper.openChange',
      async (path: string) => {
        const p = store.pendingOf(path);
        if (p?.content === null) {
          await vscode.window.showTextDocument(originalUri(path), { preview: true });
          return;
        }
        await vscode.commands.executeCommand('vscode.diff', originalUri(path), uriOf(path), `${path} (your change)`);
      },
    ],
    [
      'potentialpaper.openPage',
      () => vscode.env.openExternal(vscode.Uri.parse(new URL(store.workspace?.paper.path ?? '/', origin).toString())),
    ],
    [
      'potentialpaper.newSection',
      async (folder?: vscode.Uri) => {
        const dir = folder ? pathOf(folder) : 'community';
        const part = dir.split('/')[0];
        if (part !== 'community' && part !== 'owners') {
          void vscode.window.showInformationMessage('Sections go in community/ or owners/.');
          return;
        }
        const title = await vscode.window.showInputBox({
          prompt: 'The section’s heading',
          placeHolder: 'Why it matters',
        });
        if (!title) return;
        const taken = new Set(
          store
            .paths()
            .filter((p) => p.startsWith(`${part}/`))
            .map((p) => Number(p.slice(part.length + 1, part.length + 3))),
        );
        const last = Math.max(0, ...[...taken].filter(Number.isFinite));
        let order = Math.min(99, Math.floor(last / 10) * 10 + 10);
        while (taken.has(order) && order < 99) order += 1;
        const slug =
          title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 60) || 'section';
        const uri = uriOf(`${part}/${String(order).padStart(2, '0')}-${slug}.md`);
        await fs.writeFile(uri, new TextEncoder().encode(`# ${title}\n\n`), { create: true, overwrite: false });
        await vscode.window.showTextDocument(uri);
      },
    ],
  ];
  for (const [id, run] of commands) context.subscriptions.push(vscode.commands.registerCommand(id, run));

  // The open file, for the host page's preview, as it is typed.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sendActive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const doc = vscode.window.activeTextEditor?.document;
      const path = doc?.uri.scheme === SCHEME ? pathOf(doc.uri) : null;
      tell({ type: 'active', path, text: path && doc ? doc.getText() : null });
    }, 150);
  };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(sendActive),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) sendActive();
    }),
  );
  channel.onmessage = (event: MessageEvent<{ type?: string; path?: string }>) => {
    // The host page asks for the open file when it (re)loads, and can open one.
    if (event.data?.type === 'hello') {
      if (store.workspace) tell({ type: 'ready', previews });
      sendActive();
    }
    // `vscode.open`, so a PDF opens in its viewer.
    if (event.data?.type === 'open' && event.data.path)
      void vscode.commands.executeCommand('vscode.open', uriOf(event.data.path));
  };

  try {
    await loading;
  } catch (err) {
    void vscode.window.showErrorMessage(`The page could not be loaded: ${describe(err)}`);
    // Ready all the same, so the host page uncovers the frame and the message shows.
    tell({ type: 'ready', previews });
    return;
  }
  refreshGroup();
  if (!store.workspace?.signedIn) {
    void vscode.window.showInformationMessage('You are reading this page’s files. Sign in on the site to edit them.');
  }
  if (store.changes().length > 0 && store.baseOid !== store.head) {
    void vscode.window.showInformationMessage(
      'You have changes from before the page last changed. They will be merged when you commit.',
    );
  }
  tell({ type: 'ready', previews });
  await repos.refresh();
  sendActive();

  // Open the first community section, so there is something to start from, unless VS Code is bringing back the
  // editors of the last visit. Not awaited: those wait for this activation to finish before they can read their
  // files, and opening one meanwhile would wait for them.
  if (vscode.window.tabGroups.all.every((g) => g.tabs.length === 0)) {
    const first = store
      .paths()
      .filter((p) => p.startsWith('community/'))
      .sort()[0];
    if (first) void vscode.window.showTextDocument(uriOf(first), { preview: true });
  }
}

export function deactivate(): void {}
