/**
 * The site's web editor API (`docs/web-editor.md`, `src/server/workspace.ts`), as this extension calls it. Requests
 * are same-origin, so the reader's session cookie signs them.
 */

export interface PaperRef {
  scheme: string;
  value: string;
}

export interface RemoteFile {
  path: string;
  oid: string;
  text?: string;
  lfs?: { sha256: string; bytes: number; url: string | null };
  readonly: string | null;
}

export interface Workspace {
  paper: PaperRef & { title: string; path: string };
  head: string | null;
  files: RemoteFile[];
  signedIn: boolean;
  areas: Record<string, string | null>;
  clone: { https: string; ssh: string | null };
}

export interface Change {
  path: string;
  content: string | null;
}

export interface RebasedFile {
  path: string;
  original: string | null;
  content: string | null;
  conflict: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class Api {
  constructor(
    readonly origin: string,
    readonly paper: PaperRef,
  ) {}

  private url(path: string, query: Record<string, string> = {}): string {
    const url = new URL(`/api/v1/${path}`, this.origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return url.toString();
  }

  private async send<T>(path: string, init: RequestInit, query: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path, query), { credentials: 'same-origin', ...init });
    } catch {
      throw new ApiError(0, 'network', 'the site could not be reached; check your connection');
    }
    if (res.ok) return (await res.json()) as T;
    let error: { code?: string; message?: string; details?: Record<string, unknown> } = {};
    try {
      error = ((await res.json()) as { error?: typeof error }).error ?? {};
    } catch {
      // Not the API's error shape: a proxy's page, say.
    }
    throw new ApiError(
      res.status,
      error.code ?? 'error',
      error.message ?? `the site answered ${res.status}`,
      error.details,
    );
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  workspace(): Promise<Workspace> {
    return this.send<Workspace>('workspace', {}, { ...this.paper });
  }

  async blob(oid: string): Promise<Uint8Array> {
    const res = await fetch(this.url('workspace/blob', { ...this.paper, oid }), { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, 'error', `could not read a file (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A Git LFS file's bytes (a PDF or the picture), from where the site keeps them. */
  async lfs(url: string): Promise<Uint8Array> {
    const res = await fetch(new URL(url, this.origin));
    if (!res.ok) throw new ApiError(res.status, 'error', `could not read the file (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }

  commit(baseOid: string | null, changes: Change[], message: string) {
    return this.post<{ head: string | null; merged: boolean; changed: boolean }>('workspace/commit', {
      paper: this.paper,
      baseOid,
      changes,
      message,
    });
  }

  rebase(baseOid: string | null, changes: Change[]) {
    return this.post<{ head: string | null; files: RebasedFile[] }>('workspace/rebase', {
      paper: this.paper,
      baseOid,
      changes,
    });
  }

  /** Stores a PDF or picture for a Git LFS path; the answer is the pointer to write there. */
  async store(path: string, bytes: Uint8Array): Promise<{ pointer: string; sha256: string; bytes: number }> {
    const form = new FormData();
    form.set('scheme', this.paper.scheme);
    form.set('value', this.paper.value);
    form.set('path', path);
    form.set('file', new Blob([bytes as BlobPart]), path.split('/').pop() ?? 'file');
    return this.send('workspace/files', { method: 'POST', body: form });
  }
}
