import * as vscode from 'vscode';
import { type PageFile, type PageRepos, sectionFormat } from './page';
import { SignInNeeded, type Site } from './site';

/**
 * The preview: one panel beside the editor showing the section in front as the paper's page shows it, rendered
 * by the site (`site.ts`) as a commit would be, with the page's own stylesheet (`media/preview.css`, built from
 * `src/app/globals.css`). It follows the section being edited, as VS Code's Markdown preview does, and updates as
 * people type. The page script (`webview/preview.ts`) swaps only the blocks that changed, so the scroll position
 * and running demos stay put.
 */

/** What the panel's page is told. */
type ToPage =
  | { type: 'html'; path: string; html: string }
  | { type: 'problem'; path: string | null; text: string; signIn: boolean }
  | { type: 'empty' };

/** What the panel's page says. */
type FromPage = { type: 'ready' } | { type: 'signIn' };

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class Preview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private document: vscode.TextDocument | null = null;
  private file: PageFile | null = null;
  private last: ToPage = { type: 'empty' };
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Opened once by itself this session (`potentialpaper.previewOnOpen`); after that only when asked. */
  private autoOpened = false;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly repos: PageRepos,
    private readonly site: Site,
  ) {
    this.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => this.follow(editor)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === this.document) this.schedule(250);
      }),
      repos.onDidChange(() => this.follow(vscode.window.activeTextEditor)),
    );
  }

  /** The section in this editor, if it is one. */
  private sectionOf(editor: vscode.TextEditor | undefined): PageFile | null {
    const file = editor ? this.repos.fileOf(editor.document.uri) : null;
    return file && sectionFormat(file.path) ? file : null;
  }

  /** Keeps the context key for the editor title button up to date, and moves the preview to the new section. */
  follow(editor: vscode.TextEditor | undefined): void {
    const file = this.sectionOf(editor);
    void vscode.commands.executeCommand('setContext', 'potentialpaper.section', file !== null);
    if (!file || !editor) return;
    if (!this.panel) {
      const auto = vscode.workspace.getConfiguration('potentialpaper').get<boolean>('previewOnOpen', true);
      if (auto && !this.autoOpened) {
        this.autoOpened = true;
        this.show(editor);
      }
      return;
    }
    if (editor.document === this.document) return;
    this.document = editor.document;
    this.file = file;
    this.panel.title = `Preview ${file.path.split('/').pop()}`;
    this.schedule(0);
  }

  /** Opens the preview beside the section, or brings it forward. */
  show(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
    const file = this.sectionOf(editor);
    if (!file || !editor) {
      void vscode.window.showInformationMessage(
        'Open a section in community/ or author/ to see it as the page will show it.',
      );
      return;
    }
    this.autoOpened = true;
    this.document = editor.document;
    this.file = file;
    const title = `Preview ${file.path.split('/').pop()}`;
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      this.schedule(0);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel(
      'potentialpaper.preview',
      title,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [media] },
    );
    panel.iconPath = new vscode.ThemeIcon('open-preview');
    this.panel = panel;
    panel.webview.html = this.html(panel.webview, media);
    panel.webview.onDidReceiveMessage((message: FromPage) => {
      if (message.type === 'ready') this.post(this.last);
      if (message.type === 'signIn') void this.signIn();
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.schedule(0);
    });
    panel.onDidDispose(() => {
      this.panel = null;
      this.document = null;
      this.file = null;
      this.last = { type: 'empty' };
    });
    this.schedule(0);
  }

  private async signIn(): Promise<void> {
    if (!this.file) return;
    const origin = await this.site.originOf(this.file.root);
    if (origin && (await this.site.signIn(origin))) this.schedule(0);
  }

  private post(message: ToPage): void {
    this.last = message;
    void this.panel?.webview.postMessage(message);
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), delay);
  }

  private async update(): Promise<void> {
    const { document, file, panel } = this;
    if (!document || !file || !panel?.visible) return;
    const format = sectionFormat(file.path);
    if (!format) return;
    const mine = ++this.seq;
    try {
      const html = await this.site.render(file.root, document.getText(), format);
      if (mine === this.seq) this.post({ type: 'html', path: file.path, html });
    } catch (err) {
      if (mine !== this.seq) return;
      const signIn = err instanceof SignInNeeded;
      const text = signIn
        ? `Previews are made by ${new URL(err.origin).host}: sign in with an API key from your profile to see them.`
        : err instanceof Error
          ? err.message
          : String(err);
      this.post({ type: 'problem', path: file.path, text, signIn: signIn && file.root.scheme === 'file' });
    }
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const n = nonce();
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${n}'`,
      // Demos, which run on the site's demo host.
      'frame-src https:',
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${asset('katex/katex.min.css')}">
    <link rel="stylesheet" href="${asset('preview.css')}">
  </head>
  <body>
    <p class="preview-note" id="note"></p>
    <main class="md" id="page"></main>
    <script nonce="${n}" src="${asset('preview.js')}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.panel?.dispose();
    for (const s of this.subscriptions) s.dispose();
  }
}
