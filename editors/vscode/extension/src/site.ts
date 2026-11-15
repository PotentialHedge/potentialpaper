import * as vscode from 'vscode';
import { SCHEME, type SectionFormat } from './page';
import { originOfRemote } from './paths';

/**
 * The site, as the preview reaches it: `POST /api/v1/pages/render` turns a section into the page's HTML, the same
 * renderer a commit goes through. In the browser the editor is on the site's own origin, so the reader's session
 * signs requests. On the desktop the address comes from the clone's git remote (or the `potentialpaper.origin`
 * setting) and requests carry an API key from the profile page, kept in VS Code's secret storage.
 */

export class SignInNeeded extends Error {
  constructor(readonly origin: string) {
    super('sign in to see the preview');
  }
}

/** The origin a clone's `.git/config` points at, if it was cloned from a site. */
async function originOfClone(root: vscode.Uri): Promise<string | null> {
  try {
    const config = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, '.git/config')),
    );
    const urls = [...config.matchAll(/^\s*url\s*=\s*(\S+)/gm)].map((m) => m[1]);
    for (const url of urls) {
      const origin = originOfRemote(url);
      if (origin) return origin;
    }
  } catch {
    // Not a clone, or a worktree whose .git is a file: the setting decides.
  }
  return null;
}

export class Site {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** The site a page repo belongs to. */
  async originOf(root: vscode.Uri): Promise<string | null> {
    const configured = vscode.workspace.getConfiguration('potentialpaper').get<string>('origin');
    if (root.scheme === SCHEME) return configured || globalThis.location?.origin || null;
    return (configured || (await originOfClone(root)))?.replace(/\/+$/, '') ?? null;
  }

  private tokenKey(origin: string): string {
    return `token:${origin}`;
  }

  async signIn(origin: string): Promise<boolean> {
    const open = 'Make a key on the site';
    const token = await vscode.window.showInputBox({
      title: `Sign in to ${new URL(origin).host}`,
      prompt: `Paste an API key from your profile (${origin}/profile#agents). Read access is enough for previews.`,
      placeHolder: 'pp_live_…',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() && !/^\S+$/.test(v.trim()) ? 'A key has no spaces' : null),
    });
    if (token === undefined) {
      const pick = await vscode.window.showInformationMessage(
        'Previews are made by the site, which needs an API key from your profile.',
        open,
      );
      if (pick === open) await vscode.env.openExternal(vscode.Uri.parse(`${origin}/profile#agents`));
      return false;
    }
    if (!token.trim()) return false;
    await this.secrets.store(this.tokenKey(origin), token.trim());
    return true;
  }

  async signOut(origin: string): Promise<void> {
    await this.secrets.delete(this.tokenKey(origin));
  }

  /** A section as the page shows it. */
  async render(root: vscode.Uri, content: string, format: SectionFormat): Promise<string> {
    const origin = await this.originOf(root);
    if (!origin) {
      throw new Error(
        'This folder has no site to preview with: clone the page from the site, or set “potentialpaper.origin”.',
      );
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (root.scheme !== SCHEME) {
      const token = await this.secrets.get(this.tokenKey(origin));
      if (!token) throw new SignInNeeded(origin);
      headers.Authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await fetch(new URL('/api/v1/pages/render', origin), {
        method: 'POST',
        headers,
        body: JSON.stringify({ content, format }),
        credentials: 'same-origin',
      });
    } catch {
      throw new Error(`${new URL(origin).host} could not be reached.`);
    }
    if (res.status === 401) throw new SignInNeeded(origin);
    if (!res.ok) throw new Error(`The preview could not be made just now (${res.status}).`);
    return ((await res.json()) as { html: string }).html;
  }
}
