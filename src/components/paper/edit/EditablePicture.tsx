'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ui } from '@/components/ui';
import type { PaperId } from '@/lib/paper-ids';
import { closeEditor, messageOf, reloadAt, useEditing, useOpened, type CardOpened } from './editing';
import { EditorFrame, NotOpened } from './EditorFrame';

/**
 * The picture in "Read the paper", which turns into its editor in place (`#edit-picture`): the figure as it
 * will be, with the picture to click to choose another, and its caption written where it shows. The
 * caption is its alt text too.
 */

interface Props {
  paper: PaperId;
  /** The PDF's first page, shown when the authors' picture is removed. */
  cover: string | null;
  claimPath: string;
  /** The figure as the page shows it. */
  children: ReactNode;
}

export function EditablePicture({ paper, cover, claimPath, children }: Props) {
  const [dirty, setDirty] = useState(false);
  const active = useEditing((target) => target === 'picture', dirty);
  if (!active) return children;
  return (
    // Marks the editor open, for the page around it to make room (`paper-route.tsx`, `slots.tsx`).
    <div data-picture-editor>
      <PictureEditor paper={paper} cover={cover} claimPath={claimPath} onDirty={setDirty} />
    </div>
  );
}

function PictureEditor({
  paper,
  cover,
  claimPath,
  onDirty,
}: Omit<Props, 'children'> & { onDirty: (dirty: boolean) => void }) {
  const opening = useOpened<CardOpened>(paper, 'card');
  return (
    <EditorFrame label="Editing the picture" className="mt-1 mb-3">
      {opening.status === 'ready' ? (
        <PictureForm paper={paper} cover={cover} thumbnail={opening.data.thumbnail} onDirty={onDirty} />
      ) : (
        <NotOpened opening={opening} claimPath={claimPath} />
      )}
    </EditorFrame>
  );
}

const TYPES = 'image/jpeg,image/png,image/gif,image/webp,image/avif';

function PictureForm({
  paper,
  cover,
  thumbnail,
  onDirty,
}: {
  paper: PaperId;
  cover: string | null;
  thumbnail: CardOpened['thumbnail'];
  onDirty: (dirty: boolean) => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [caption, setCaption] = useState(thumbnail?.caption ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const dirty = chosen !== null || caption !== (thumbnail?.caption ?? '');
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  async function send(request: () => Promise<Response>) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await request();
      if (!res.ok) return setProblem(await messageOf(res));
      onDirty(false);
      reloadAt((await res.json()).head);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('scheme', paper.scheme);
    form.set('value', paper.value);
    const image = form.get('image');
    if (!thumbnail && !(image instanceof File && image.size > 0)) return setProblem('Choose a picture.');
    void send(() => fetch('/api/v1/pages/thumbnail', { method: 'POST', body: form }));
  }

  function remove() {
    const query = new URLSearchParams({ scheme: paper.scheme, value: paper.value });
    void send(() => fetch(`/api/v1/pages/thumbnail?${query}`, { method: 'DELETE' }));
  }

  function cancel() {
    onDirty(false);
    closeEditor();
  }

  const shown = chosen ?? thumbnail?.url ?? cover;
  return (
    <form onSubmit={save}>
      <figure>
        <label className="group relative block cursor-pointer border border-rule bg-white">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt={caption} className="w-full" />
          ) : (
            <span className="block p-6 text-center text-muted italic">No picture yet</span>
          )}
          <span className="absolute inset-x-0 bottom-0 bg-ink/70 py-1 text-center text-xs text-white opacity-90 group-hover:opacity-100">
            {shown ? 'Choose another picture' : 'Choose a picture'}
          </span>
          <input
            name="image"
            type="file"
            accept={TYPES}
            className="sr-only"
            onChange={(e) => {
              // A data: address, which the CSP's img-src allows, where a blob: one is not.
              const file = e.target.files?.[0];
              if (!file) return setChosen(null);
              const reader = new FileReader();
              reader.onload = () => setChosen(typeof reader.result === 'string' ? reader.result : null);
              reader.readAsDataURL(file);
            }}
          />
        </label>
        <figcaption className={`${ui.caption} flex items-baseline gap-1`}>
          <b className="shrink-0">Figure 1:</b>
          <input
            name="caption"
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={500}
            placeholder="A caption"
            aria-label="Caption"
            className="min-w-0 flex-1 border-b border-dashed border-rule-strong bg-transparent font-serif text-[13px] focus:border-frame focus:outline-none narrow:text-base"
          />
        </figcaption>
      </figure>
      <p className="mt-3 text-xs text-faint">
        Shown in place of the PDF&apos;s first page: a teaser figure, a diagram, or an animated GIF. JPEG, PNG, GIF,
        WebP or AVIF, up to 8 MB.
      </p>
      <div className="flex flex-wrap items-baseline gap-x-4">
        <button type="submit" disabled={busy} className={ui.btn({ inline: true })}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={cancel} className={ui.btn({ inline: true, ghost: true })}>
          Cancel
        </button>
      </div>
      {thumbnail && (
        <button type="button" disabled={busy} onClick={remove} className={`${ui.linkBtn} mt-2 text-xs`}>
          Use the PDF&apos;s first page instead
        </button>
      )}
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}
