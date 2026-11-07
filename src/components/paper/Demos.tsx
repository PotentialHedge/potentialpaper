'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ui } from '@/components/ui';
import { demoUrl, type DemoPointer } from '@/lib/demos';
import type { PaperId } from '@/lib/paper-ids';
import { authHref } from '@/lib/return-to';

/**
 * A paper's demos: code from GitHub, each run on click in a frame on the demo host, so a heavy scene costs
 * nothing until someone asks for it. The list is in the cached page; whether the reader may add or remove
 * one is filled in afterwards, as the navbar's viewer is.
 */

/** What the frame may do: run scripts, keep its own storage, and take the pointer, the screen and a headset. */
const SANDBOX = 'allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms allow-downloads';
const ALLOW = 'fullscreen; xr-spatial-tracking; gamepad; autoplay; accelerometer; gyroscope; clipboard-write';

/** The files' own page on GitHub, at the commit they were copied from. */
function sourceAt(demo: DemoPointer): string {
  if (demo.source.startsWith('https://gist.github.com/')) return `${demo.source}/${demo.commit}`;
  return `${demo.source}/tree/${demo.commit}${demo.root ? `/${demo.root}` : ''}`;
}

function sourceLabel(demo: DemoPointer): string {
  const name = demo.source.replace(/^https:\/\/(gist\.)?github\.com\//, '');
  return `${name}${demo.root ? `/${demo.root}` : ''}@${demo.commit.slice(0, 7)}`;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  if (res.status === 401) return 'Sign in first.';
  return body?.error?.message ?? `Something went wrong (${res.status}).`;
}

/** Shows the page again, past every cache, once a change is committed. */
function reloadAt(pathname: string, head: string | null) {
  window.location.replace(`${pathname}?v=${(head ?? Date.now().toString(16)).slice(0, 12)}`);
}

function Demo({ demo, index, canEdit, paper }: { demo: DemoPointer; index: number; canEdit: boolean; paper: PaperId }) {
  const pathname = usePathname();
  const frame = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const url = demoUrl(demo.id);

  async function remove() {
    setProblem(null);
    const query = new URLSearchParams({ scheme: paper.scheme, value: paper.value, id: demo.id });
    const res = await fetch(`/api/v1/demos?${query}`, { method: 'DELETE' });
    if (!res.ok) return setProblem(await errorMessage(res));
    reloadAt(pathname, (await res.json()).head);
  }

  return (
    <figure className="mt-4">
      <div ref={frame} className="relative aspect-video w-full border border-frame bg-[#111]">
        {running ? (
          <iframe
            src={url}
            title={demo.title}
            sandbox={SANDBOX}
            allow={ALLOW}
            allowFullScreen
            className="absolute inset-0 h-full w-full border-0 bg-white"
          />
        ) : (
          <button
            type="button"
            onClick={() => setRunning(true)}
            className="absolute inset-0 flex cursor-pointer flex-col items-center justify-center gap-2 font-sans text-white"
          >
            <span aria-hidden className="text-4xl leading-none">
              ▶
            </span>
            <span className="text-sm font-semibold">Run demo</span>
          </button>
        )}
      </div>
      <figcaption className={ui.caption}>
        <b>Demo {index + 1}:</b> {demo.title}
        {demo.description && <span>. {demo.description}</span>}
      </figcaption>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-sans text-xs text-muted">
        {running && (
          <button type="button" className={ui.linkBtn} onClick={() => frame.current?.requestFullscreen?.()}>
            full screen
          </button>
        )}
        {running && (
          <button type="button" className={ui.linkBtn} onClick={() => setRunning(false)}>
            stop
          </button>
        )}
        <a href={url} target="_blank" rel="noopener">
          open in a new tab
        </a>
        <a href={sourceAt(demo)} rel="noopener" className="font-mono">
          {sourceLabel(demo)}
        </a>
        {canEdit && (
          <button type="button" className={ui.linkBtn} onClick={remove}>
            remove
          </button>
        )}
      </p>
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </figure>
  );
}

function AttachForm({ paper }: { paper: PaperId }) {
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch('/api/v1/demos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paper,
          url: String(form.get('url') ?? '').trim(),
          title: String(form.get('title') ?? '').trim(),
          description: String(form.get('description') ?? '').trim() || undefined,
        }),
      });
      if (!res.ok) {
        setProblem(await errorMessage(res));
        return;
      }
      reloadAt(pathname, (await res.json()).head);
    } catch {
      setProblem('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className={`${ui.box} mt-4`}>
      <summary className="cursor-pointer font-semibold">Attach a demo</summary>
      <form onSubmit={submit} className="mt-3">
        <label className="block">
          <span className="text-muted">GitHub repo, folder or gist</span>
          <input
            name="url"
            type="url"
            required
            placeholder="https://github.com/you/demo/tree/main/dist"
            className={ui.input}
          />
        </label>
        <label className="block">
          <span className="text-muted">Title</span>
          <input name="title" required maxLength={120} className={ui.input} />
        </label>
        <label className="block">
          <span className="text-muted">What it shows (optional)</span>
          <textarea name="description" maxLength={500} rows={2} className={ui.input} />
        </label>
        <p className={ui.fine}>
          The folder needs an <code>index.html</code> and the built files: nothing is built here. A repo with none at
          the top is searched in <code>dist</code>, <code>build</code>, <code>docs</code> and <code>public</code>. Up to
          50 MB. The files are copied at today&apos;s commit, so later pushes don&apos;t change the demo.
        </p>
        <button type="submit" disabled={busy} className={ui.btn({ inline: true })}>
          {busy ? 'Copying from GitHub…' : 'Attach'}
        </button>
        {problem && <p className={ui.note(false)}>{problem}</p>}
      </form>
    </details>
  );
}

export function DemosSection({ demos, paper }: { demos: DemoPointer[]; paper: PaperId }) {
  const pathname = usePathname();
  // `undefined` until known; the cached page is the same for everyone.
  const [viewer, setViewer] = useState<{ handle: string } | null | undefined>(undefined);

  useEffect(() => {
    let current = true;
    fetch('/api/v1/viewer', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => current && setViewer(body?.viewer ?? null))
      .catch(() => current && setViewer(null));
    return () => {
      current = false;
    };
  }, []);

  return (
    <section>
      <h2 className={ui.groupHeading}>Demos</h2>
      {demos.length === 0 && <p className={ui.empty}>Nobody has attached a demo yet.</p>}
      {demos.map((demo, index) => (
        <Demo key={demo.id} demo={demo} index={index} canEdit={Boolean(viewer)} paper={paper} />
      ))}
      {viewer && <AttachForm paper={paper} />}
      {viewer === null && (
        <p className={ui.fine}>
          <a href={authHref('/signin', pathname)}>Sign in</a> to attach a demo from GitHub.
        </p>
      )}
    </section>
  );
}
