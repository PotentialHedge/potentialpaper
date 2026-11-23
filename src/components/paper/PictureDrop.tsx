'use client';

import { useRouter } from 'next/navigation';
import { type DragEvent, useId, useRef, useState } from 'react';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
import { AddMissing } from './AddMissing';

/** The pictures a page takes, as `thumbnail.<ext>` (`server/pages/rules.ts`), by MIME type. */
const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
};
/** `MAX_THUMBNAIL_BYTES`. */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Where a paper's picture goes when it has none (no `thumbnail.<ext>`, and no PDF whose first page could stand in): an
 * empty frame to drop an image on, or pick one, which is stored (`POST /api/v1/workspace/files`) and committed as the
 * page's `thumbnail.<ext>` (`POST /api/v1/workspace/commit`), as the web editor does; or a prompt for the reader's AI
 * agent (`/agent/add/picture`). The path rules decide who may (`rules.ts`): anyone verified until the paper is
 * claimed, then its authors.
 */
export function PictureDrop({ canonical, paperPath }: { canonical: PaperId; paperPath: string }) {
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    const ext = TYPES[file.type];
    if (!ext) return setError('That isn’t a picture this page takes: use PNG, JPG, GIF, WebP or AVIF.');
    if (file.size > MAX_BYTES) return setError('That picture is over 8 MB.');
    setBusy(true);
    try {
      const ref = { scheme: canonical.scheme, value: canonical.value };
      const workspace = await fetch(`/api/v1/workspace?${new URLSearchParams(ref)}`);
      if (!workspace.ok) return setError(await failure(workspace));
      const { head } = (await workspace.json()) as { head: string | null };
      const path = `thumbnail.${ext}`;
      const form = new FormData();
      form.set('scheme', ref.scheme);
      form.set('value', ref.value);
      form.set('path', path);
      form.set('file', file);
      const stored = await fetch('/api/v1/workspace/files', { method: 'POST', body: form });
      if (!stored.ok) return setError(await failure(stored));
      const { pointer } = (await stored.json()) as { pointer: string };
      const committed = await fetch('/api/v1/workspace/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paper: ref,
          baseOid: head,
          changes: [{ path, content: pointer }],
          message: 'Add a picture',
        }),
      });
      if (!committed.ok) return setError(await failure(committed));
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void upload(file);
  };

  return (
    <div className="mb-3">
      <label
        htmlFor={inputId}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={`flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1.5 border border-dashed px-4 text-center font-sans text-[13px] transition-colors ${
          over ? 'border-accent bg-highlight/60' : 'border-rule-strong bg-white hover:border-frame'
        }`}
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="size-7 text-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="4.5" width="18" height="15" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="M3 17l5-5 4 4 3-3 6 6" />
        </svg>
        {busy ? (
          <span className="text-muted">Adding the picture…</span>
        ) : (
          <>
            <span className="text-ink">No picture yet</span>
            <span className="text-muted">
              Drop one here or <span className="text-accent underline">choose a file</span>
            </span>
            <span className={ui.fine}>PNG, JPG, GIF, WebP or AVIF, up to 8 MB</span>
          </>
        )}
      </label>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept={Object.keys(TYPES).join(',')}
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
      {error && <p className={ui.note(false)}>{error}</p>}
      {/* A div: the prompt's dialog can't be inside a <p>. */}
      <div className={`${ui.fine} mt-1.5`}>
        <AddMissing what="picture" paperPath={paperPath} />
      </div>
    </div>
  );
}

async function failure(res: Response): Promise<string> {
  if (res.status === 401) return 'Sign in to add a picture.';
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}
