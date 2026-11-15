import * as vscode from 'vscode';

/**
 * PDFs open as PDFs: a read-only custom editor for `*.pdf` with PDF.js (`webview/pdf.ts`, bundled with its fonts,
 * character maps and decoders into `media/pdf/`). The bytes are read through VS Code, so the same viewer shows a
 * version in the browser (from where the site keeps it, `store.ts`) and in a clone on the desktop. A file that is
 * still a Git LFS pointer says so instead.
 */

export const PDF_VIEW = 'potentialpaper.pdf';

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

type ToPage =
  | { type: 'pdf'; bytes: Uint8Array; name: string }
  | { type: 'problem'; text: string }
  | { type: 'zoom'; by: 'in' | 'out' | 'width' };

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class PdfViewer implements vscode.CustomReadonlyEditorProvider {
  /** The viewer in front, for the zoom buttons in the editor's title. */
  private active: vscode.WebviewPanel | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const viewer = new PdfViewer(context.extensionUri);
    const zoom = (by: 'in' | 'out' | 'width') => () =>
      void viewer.active?.webview.postMessage({ type: 'zoom', by } satisfies ToPage);
    return vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(PDF_VIEW, viewer, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand('potentialpaper.pdfZoomIn', zoom('in')),
      vscode.commands.registerCommand('potentialpaper.pdfZoomOut', zoom('out')),
      vscode.commands.registerCommand('potentialpaper.pdfFitWidth', zoom('width')),
    );
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.extensionUri, 'media', 'pdf');
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    panel.webview.html = this.html(panel.webview, media);
    if (panel.active) this.active = panel;
    panel.onDidChangeViewState(() => {
      if (panel.active) this.active = panel;
      else if (this.active === panel) this.active = null;
    });
    panel.onDidDispose(() => {
      if (this.active === panel) this.active = null;
    });

    const name = document.uri.path.split('/').pop() ?? 'PDF';
    const load = async (): Promise<ToPage> => {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(document.uri);
      } catch (err) {
        return { type: 'problem', text: `${name} could not be read: ${err instanceof Error ? err.message : err}` };
      }
      if (new TextDecoder().decode(bytes.subarray(0, LFS_POINTER.length)) === LFS_POINTER) {
        return {
          type: 'problem',
          text:
            document.uri.scheme === 'file'
              ? `${name} is a Git LFS pointer: the PDF itself isn't in this clone. Install Git LFS and run “git lfs pull”.`
              : `Only ${name}'s Git LFS pointer could be read, not the PDF itself.`,
        };
      }
      return { type: 'pdf', bytes, name };
    };
    const loaded = load();
    panel.webview.onDidReceiveMessage(async (message: { type?: string; href?: string }) => {
      if (message.type === 'ready') void panel.webview.postMessage(await loaded);
      if (message.type === 'link' && message.href && /^(https?|mailto):/.test(message.href)) {
        void vscode.env.openExternal(vscode.Uri.parse(message.href));
      }
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const n = nonce();
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data: blob:`,
      `connect-src ${webview.cspSource}`,
      // PDF.js decodes JPEG 2000 and JBIG2 with WebAssembly.
      `script-src 'nonce-${n}' 'wasm-unsafe-eval'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${asset('pdf_viewer.css')}">
    <link rel="stylesheet" href="${asset('viewer.css')}">
  </head>
  <body data-base="${asset('')}">
    <div id="bar">
      <span id="pages"></span>
      <span id="zoom"></span>
    </div>
    <p id="note" hidden></p>
    <div id="viewerContainer"><div id="viewer" class="pdfViewer"></div></div>
    <script nonce="${n}" type="module" src="${asset('viewer.js')}"></script>
  </body>
</html>`;
  }
}
