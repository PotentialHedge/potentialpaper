import * as vscode from 'vscode';
import { type Api, ApiError, type Change, type RemoteFile, type Workspace } from './api';
import { SCHEME } from './page';

/**
 * The page repo as this editor holds it: the files at the head the site gave, and on top of them the changes
 * made here and not yet committed. Changes are kept with the commit they were made from (`baseOid`) and each
 * file's text there (`original`), so a commit merges correctly with whatever happened since, and they are
 * saved in the browser (`workspaceState`), so a reload loses nothing.
 */

export { SCHEME };
/** The files as they were before the changes, for diffs. */
export const ORIGINAL_SCHEME = 'potentialpaper-original';

export interface Pending {
  /** The file's text where the change started, `null` if it is new. */
  original: string | null;
  /** The text now, `null` if it was deleted. */
  content: string | null;
  /** Merged from someone else's commit with conflict markers, to be settled before committing. */
  conflict?: boolean;
  at: number;
}

interface Saved {
  baseOid: string | null;
  pending: Record<string, Pending>;
  dirs?: string[];
}

/** Folders the site lists as places to add to, but not these, which are added to by other means. */
const UNLISTED = new Set(['.potentialpaper', 'demos']);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeText(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** The paths that are kept with Git LFS (`src/server/pages/rules.ts`, `lfsKindOf`). */
export function isLfsPath(path: string): boolean {
  return (
    path === '.potentialpaper/paper.pdf' ||
    /^versions\/[^/]+\.pdf$/.test(path) ||
    /^thumbnail\.(png|jpg|jpeg|gif|webp|avif)$/.test(path)
  );
}

export class Store {
  private remote = new Map<string, RemoteFile>();
  private bytes = new Map<string, Uint8Array>();
  private pending = new Map<string, Pending>();
  private dirs = new Set<string>();
  private loadedAt = Date.now();
  baseOid: string | null = null;
  workspace: Workspace | null = null;

  private readonly changed = new vscode.EventEmitter<string[]>();
  /** Paths whose content or presence changed, after a load, a write or a commit. */
  readonly onDidChange = this.changed.event;

  constructor(
    readonly api: Api,
    private readonly state: vscode.Memento,
    private readonly key: string,
  ) {
    const saved = state.get<Saved>(key);
    if (saved) {
      this.baseOid = saved.baseOid;
      for (const [path, p] of Object.entries(saved.pending)) this.pending.set(path, p);
      for (const dir of saved.dirs ?? []) this.dirs.add(dir);
    }
  }

  get head(): string | null {
    return this.workspace?.head ?? null;
  }

  /** Loads the page's head. Changes made here stay, still against the commit they were made from. */
  async load(): Promise<void> {
    const workspace = await this.api.workspace();
    const before = new Set([...this.remote.keys(), ...this.pending.keys()]);
    this.workspace = workspace;
    this.remote = new Map(workspace.files.map((f) => [f.path, f]));
    this.bytes.clear();
    this.loadedAt = Date.now();
    if (this.pending.size === 0) this.baseOid = workspace.head;
    // Nothing to keep a change of: it is what the page has now (committed from elsewhere, say).
    for (const [path, p] of this.pending) {
      const remote = this.remote.get(path);
      if (p.content === null ? !remote : remote?.text !== undefined && remote.text === p.content)
        this.pending.delete(path);
    }
    if (this.pending.size === 0) this.baseOid = workspace.head;
    this.save();
    this.changed.fire([...new Set([...before, ...this.remote.keys()])]);
  }

  private save(): void {
    void this.state.update(this.key, {
      baseOid: this.baseOid,
      pending: Object.fromEntries(this.pending),
      dirs: [...this.dirs],
    } satisfies Saved);
  }

  changes(): [string, Pending][] {
    return [...this.pending].sort(([a], [b]) => a.localeCompare(b));
  }

  pendingOf(path: string): Pending | undefined {
    return this.pending.get(path);
  }

  remoteOf(path: string): RemoteFile | undefined {
    return this.remote.get(path);
  }

  /** Why this viewer can't write the path, or `null`. The commit decides in the end. */
  readonlyReason(path: string): string | null {
    const remote = this.remote.get(path);
    if (remote) return remote.readonly;
    const areas = this.workspace?.areas ?? {};
    const area = Object.keys(areas).find((a) => (a.endsWith('/') ? path.startsWith(a) : path === a));
    if (area) return areas[area];
    if (!this.workspace?.signedIn) return 'sign in to edit';
    return null;
  }

  /** The page's folders, shown even while empty so a new page shows where things go: its kind's (`areas`). */
  folders(): string[] {
    return Object.keys(this.workspace?.areas ?? {})
      .filter((area) => area.endsWith('/'))
      .map((area) => area.slice(0, -1))
      .filter((folder) => !UNLISTED.has(folder));
  }

  exists(path: string): boolean {
    const p = this.pending.get(path);
    return p ? p.content !== null : this.remote.has(path);
  }

  isDir(path: string): boolean {
    if (path === '' || this.folders().includes(path)) return true;
    if (this.dirs.has(path)) return true;
    const prefix = `${path}/`;
    for (const p of this.paths()) if (p.startsWith(prefix)) return true;
    return false;
  }

  /** Every file there is now. */
  paths(): string[] {
    const all = new Set(this.remote.keys());
    for (const [path, p] of this.pending) {
      if (p.content === null) all.delete(path);
      else all.add(path);
    }
    return [...all];
  }

  children(dir: string): [string, vscode.FileType][] {
    const prefix = dir ? `${dir}/` : '';
    const found = new Map<string, vscode.FileType>();
    const add = (path: string) => {
      if (!path.startsWith(prefix)) return;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) found.set(rest, vscode.FileType.File);
      else found.set(rest.slice(0, slash), vscode.FileType.Directory);
    };
    if (dir === '') for (const folder of this.folders()) found.set(folder, vscode.FileType.Directory);
    for (const path of this.paths()) add(path);
    for (const d of this.dirs)
      if (d !== dir && d.startsWith(prefix)) found.set(d.slice(prefix.length).split('/')[0], vscode.FileType.Directory);
    return [...found];
  }

  mtime(path: string): number {
    return this.pending.get(path)?.at ?? this.loadedAt;
  }

  async read(path: string): Promise<Uint8Array> {
    const p = this.pending.get(path);
    if (p) {
      if (p.content === null) throw vscode.FileSystemError.FileNotFound(path);
      return this.bytes.get(path) ?? encoder.encode(p.content);
    }
    return this.readRemote(path);
  }

  private async readRemote(path: string): Promise<Uint8Array> {
    const remote = this.remote.get(path);
    if (!remote) throw vscode.FileSystemError.FileNotFound(path);
    const cached = this.bytes.get(path);
    if (cached) return cached;
    let bytes: Uint8Array;
    if (remote.lfs?.url) {
      // The PDF or picture itself, so it opens as one. Its pointer, if the bytes can't be had.
      try {
        bytes = await this.api.lfs(remote.lfs.url);
      } catch {
        bytes = await this.api.blob(remote.oid);
      }
    } else if (remote.text !== undefined) {
      bytes = encoder.encode(remote.text);
    } else {
      bytes = await this.api.blob(remote.oid);
    }
    this.bytes.set(path, bytes);
    return bytes;
  }

  /** The file's text at the commit the changes are made from, for a diff. */
  async original(path: string): Promise<string> {
    const p = this.pending.get(path);
    if (p) return p.original ?? '';
    if (!this.remote.has(path)) return '';
    return decodeText(await this.readRemote(path)) ?? '';
  }

  private async remoteText(path: string): Promise<string | null> {
    const remote = this.remote.get(path);
    if (!remote) return null;
    if (remote.text !== undefined) return remote.text;
    if (remote.lfs) return null;
    return decodeText(await this.api.blob(remote.oid));
  }

  /** The pointer text a Git LFS file has in the repo. */
  private async remotePointer(path: string): Promise<string | null> {
    const remote = this.remote.get(path);
    if (!remote) return null;
    return decodeText(await this.api.blob(remote.oid));
  }

  private async originalFor(path: string): Promise<string | null> {
    const existing = this.pending.get(path);
    if (existing) return existing.original;
    return isLfsPath(path) ? this.remotePointer(path) : this.remoteText(path);
  }

  private set(path: string, content: string | null, original: string | null, bytes?: Uint8Array): void {
    if (content === original) {
      this.pending.delete(path);
    } else {
      this.pending.set(path, { original, content, at: Date.now(), conflict: this.pending.get(path)?.conflict });
    }
    if (bytes) this.bytes.set(path, bytes);
    else this.bytes.delete(path);
    for (let dir = path; dir.includes('/');) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      this.dirs.delete(dir);
    }
    this.save();
    this.changed.fire([path]);
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    const reason = this.readonlyReason(path);
    if (reason) throw vscode.FileSystemError.NoPermissions(`${path}: ${reason}`);
    const original = await this.originalFor(path);
    if (isLfsPath(path)) {
      const text = decodeText(bytes);
      // A pointer written by hand stays one; anything else is the file itself, stored now and pointed at.
      if (text !== null && text.startsWith('version https://git-lfs.github.com/spec/v1')) {
        this.set(path, text, original);
        return;
      }
      const stored = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Uploading ${path}…` },
        () => this.api.store(path, bytes),
      );
      this.set(path, stored.pointer, original, bytes);
      return;
    }
    const text = decodeText(bytes);
    if (text === null) {
      throw vscode.FileSystemError.NoPermissions(
        `${path}: pages hold text files; a picture goes in thumbnail.png (or .jpg, .gif, .webp, .avif), a PDF in versions/<id>.pdf`,
      );
    }
    this.set(path, text, original);
  }

  async delete(path: string): Promise<void> {
    const reason = this.readonlyReason(path);
    if (reason) throw vscode.FileSystemError.NoPermissions(`${path}: ${reason}`);
    if (!this.exists(path)) throw vscode.FileSystemError.FileNotFound(path);
    const original = await this.originalFor(path);
    if (original === null && this.pending.has(path)) {
      // Made here and never committed: it just goes.
      this.pending.delete(path);
      this.bytes.delete(path);
      this.save();
      this.changed.fire([path]);
      return;
    }
    this.set(path, null, original);
  }

  mkdir(path: string): void {
    this.dirs.add(path);
    this.save();
    this.changed.fire([path]);
  }

  removeDir(path: string): void {
    this.dirs.delete(path);
    this.save();
  }

  discard(path: string): void {
    if (!this.pending.delete(path)) return;
    this.bytes.delete(path);
    if (this.pending.size === 0) this.baseOid = this.head;
    this.save();
    this.changed.fire([path]);
  }

  discardAll(): void {
    const paths = [...this.pending.keys()];
    this.pending.clear();
    this.bytes.clear();
    this.baseOid = this.head;
    this.save();
    this.changed.fire(paths);
  }

  conflicts(): string[] {
    return this.changes()
      .filter(([, p]) => p.conflict && p.content !== null && /^<<<<<<< /m.test(p.content))
      .map(([path]) => path);
  }

  /** Commits every change. A `409 edit_conflict` moves the changes onto the head with markers, and throws. */
  async commit(message: string): Promise<{ head: string | null; changed: boolean }> {
    const changes: Change[] = this.changes().map(([path, p]) => ({ path, content: p.content }));
    try {
      const result = await this.api.commit(this.baseOid, changes, message);
      const paths = [...this.pending.keys()];
      this.pending.clear();
      this.save();
      await this.load();
      this.changed.fire(paths);
      return result;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'edit_conflict') await this.rebase(changes);
      throw err;
    }
  }

  /** Moves the changes onto the page's head, merging, with conflict markers where both changed the same lines. */
  async rebase(
    changes: Change[] = this.changes().map(([path, p]) => ({ path, content: p.content })),
  ): Promise<string[]> {
    const { head, files } = await this.api.rebase(this.baseOid, changes);
    await this.load();
    for (const file of files) {
      if (file.content === file.original) this.pending.delete(file.path);
      else
        this.pending.set(file.path, {
          original: file.original,
          content: file.content,
          conflict: file.conflict,
          at: Date.now(),
        });
      this.bytes.delete(file.path);
    }
    this.baseOid = head;
    this.save();
    this.changed.fire(files.map((f) => f.path));
    return files.filter((f) => f.conflict).map((f) => f.path);
  }
}
