'use client';

import { useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';
import { MAX_LINK_LABEL, MAX_LINKS, type TitleLink } from '@/lib/paper-links';
import type { PaperId } from '@/lib/paper-ids';
import type { ThumbnailPointer } from '@/server/pages/rules';

/**
 * The paper's card: the picture in "Read the paper", and the links under its title. Each saves on its own,
 * as a commit, then shows the page again past every cache.
 */

interface Props {
  paper: PaperId;
  pagePath: string;
  thumbnail: ThumbnailPointer | null;
  links: TitleLink[];
  claimed: boolean;
}

async function messageOf(res: Response): Promise<string> {
  if (res.status === 401) return 'Your session ended. Sign in again in another tab, then save.';
  if (res.status === 413) return 'The picture is too large.';
  const body = await res.json().catch(() => null);
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

function backTo(pagePath: string, head: string | null) {
  window.location.replace(`${pagePath}?v=${(head ?? Date.now().toString(16)).slice(0, 12)}`);
}

export function CardEditor({ paper, pagePath, thumbnail, links, claimed }: Props) {
  return (
    <div className="font-sans text-sm">
      <p className={`${ui.fine} mt-4`}>
        {claimed
          ? "The paper is claimed, so its confirmed authors choose these. Every change is in the page's history."
          : "Until an author claims the paper, any verified researcher can change these. Every change is in the page's history."}
      </p>
      <PictureForm paper={paper} pagePath={pagePath} thumbnail={thumbnail} />
      <LinksForm paper={paper} pagePath={pagePath} initial={links} />
    </div>
  );
}

function PictureForm({ paper, pagePath, thumbnail }: Omit<Props, 'links' | 'claimed'>) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    form.set('scheme', paper.scheme);
    form.set('value', paper.value);
    const image = form.get('image');
    if (!thumbnail && !(image instanceof File && image.size > 0)) return setProblem('Choose a picture.');
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/pages/thumbnail', { method: 'POST', body: form });
      if (!res.ok) return setProblem(await messageOf(res));
      backTo(pagePath, (await res.json()).head);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setProblem(null);
    try {
      const query = new URLSearchParams({ scheme: paper.scheme, value: paper.value });
      const res = await fetch(`/api/v1/pages/thumbnail?${query}`, { method: 'DELETE' });
      if (!res.ok) return setProblem(await messageOf(res));
      backTo(pagePath, (await res.json()).head);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  const preview = chosen ?? thumbnail?.url ?? null;
  return (
    <form onSubmit={save} id="picture" className="mt-6">
      <h2 className={ui.sectionHeading}>Picture</h2>
      <p className={ui.fine}>
        Shown in place of the PDF&apos;s first page: a teaser figure, a diagram, or an animated GIF. JPEG, PNG, GIF,
        WebP or AVIF, up to 8 MB.
      </p>
      <div className="mt-3 grid grid-cols-[230px_minmax(0,1fr)] gap-6 narrow:grid-cols-1">
        <div className="border border-rule bg-white">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt={thumbnail?.alt ?? ''} className="w-full" />
          ) : (
            <p className="p-6 text-center text-muted italic">The PDF&apos;s first page</p>
          )}
        </div>
        <div>
          <label className="block">
            <span className="text-muted">{thumbnail ? 'A new picture (optional)' : 'Picture'}</span>
            <input
              name="image"
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
              className={ui.input}
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
          <label className="block">
            <span className="text-muted">What it shows, for someone who can&apos;t see it</span>
            <input name="alt" defaultValue={thumbnail?.alt ?? ''} maxLength={500} className={ui.input} />
          </label>
          <label className="block">
            <span className="text-muted">Caption, after “Figure 1:” (optional)</span>
            <input name="caption" defaultValue={thumbnail?.caption ?? ''} maxLength={500} className={ui.input} />
          </label>
          <div className="flex items-baseline gap-4">
            <button type="submit" disabled={busy} className={ui.btn({ inline: true })}>
              {busy ? 'Saving…' : 'Save the picture'}
            </button>
            {thumbnail && (
              <button type="button" disabled={busy} onClick={remove} className={ui.linkBtn}>
                Use the PDF&apos;s first page instead
              </button>
            )}
          </div>
          {problem && <p className={ui.note(false)}>{problem}</p>}
        </div>
      </div>
    </form>
  );
}

function LinksForm({ paper, pagePath, initial }: { paper: PaperId; pagePath: string; initial: TitleLink[] }) {
  const [rows, setRows] = useState<TitleLink[]>(initial.length > 0 ? initial : [{ label: '', url: '' }]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  function change(index: number, key: keyof TitleLink, value: string) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const links = rows.filter((row) => row.label.trim() || row.url.trim());
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/pages/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper, links }),
      });
      if (!res.ok) return setProblem(await messageOf(res));
      backTo(pagePath, (await res.json()).head);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} id="links" className="mt-10">
      <h2 className={ui.sectionHeading}>Links</h2>
      <p className={ui.fine}>
        Shown under the title, after the paper&apos;s own: Code, Project page, Video, Slides, Poster. One called PDF,
        arXiv, OpenReview, DOI or Scholar replaces that link.
      </p>
      <div className="mt-3 space-y-1">
        {rows.map((row, index) => (
          <div key={index} className="flex items-start gap-2">
            <input
              value={row.label}
              onChange={(e) => change(index, 'label', e.target.value)}
              placeholder="Code"
              maxLength={MAX_LINK_LABEL}
              aria-label={`Link ${index + 1}: label`}
              className={`${ui.input} max-w-40`}
            />
            <input
              value={row.url}
              onChange={(e) => change(index, 'url', e.target.value)}
              placeholder="https://github.com/…"
              type="url"
              aria-label={`Link ${index + 1}: address`}
              className={ui.input}
            />
            <button
              type="button"
              onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
              className={`${ui.linkBtn} mt-1.5`}
              aria-label={`Remove link ${index + 1}`}
            >
              remove
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-baseline gap-4">
        {rows.length < MAX_LINKS && (
          <button
            type="button"
            onClick={() => setRows((current) => [...current, { label: '', url: '' }])}
            className={ui.linkBtn}
          >
            Add a link
          </button>
        )}
        <button type="submit" disabled={busy} className={ui.btn({ inline: true })}>
          {busy ? 'Saving…' : 'Save the links'}
        </button>
        <a href={pagePath}>Cancel</a>
      </div>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </form>
  );
}
