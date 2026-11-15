'use client';

import { useEffect, useRef, useState } from 'react';
import { DemoFrames } from '@/components/paper/DemoFrames';
import { ui } from '@/components/ui';
import { editorChannelName, type EditorMessage, type HostMessage } from '@/editors/channel';
import type { PaperId } from '@/lib/paper-ids';
import { PreviewHtml } from './PreviewHtml';

/**
 * The page around a web editor (`src/editors`): the editor in a frame, and beside it the file being edited as
 * the paper's page will show it, rendered by the site as a commit would, unless the editor says it shows that
 * itself (VS Code does, in a panel of its own, where it can open webviews). Knows nothing of which editor it is:
 * the editor tells it what is open through the channel (`src/editors/channel.ts`).
 */

/** A section file, which the page shows as prose: `community/10-summary.md`, `author/20-results.html`. */
function sectionFormat(path: string | null): 'markdown' | 'html' | null {
  const match = path && /^(?:author|community)\/\d{2}-[a-z0-9-]+\.(md|html)$/.exec(path);
  return match ? (match[1] === 'md' ? 'markdown' : 'html') : null;
}

export function EditorHost({
  paper,
  frameSrc,
  editorName,
  pagePath,
}: {
  paper: PaperId;
  frameSrc: string;
  editorName: string;
  pagePath: string;
}) {
  const [active, setActive] = useState<{ path: string | null; text: string | null }>({ path: null, text: null });
  /** The last preview made, and of which file. */
  const [rendered, setRendered] = useState<{ path: string; html: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  /** Whether the editor previews sections itself; not known until it has loaded. */
  const [editorPreviews, setEditorPreviews] = useState<boolean | null>(null);
  const format = sectionFormat(active.path);
  const html = rendered && rendered.path === active.path ? rendered.html : null;
  const seq = useRef(0);

  useEffect(() => {
    const channel = new BroadcastChannel(editorChannelName(paper));
    channel.onmessage = (event: MessageEvent<EditorMessage>) => {
      const message = event.data;
      if (message?.type === 'ready') setEditorPreviews(Boolean(message.previews));
      if (message?.type === 'active') setActive({ path: message.path, text: message.text });
      if (message?.type === 'committed') setCommitted(true);
    };
    channel.postMessage({ type: 'hello' } satisfies HostMessage);
    return () => channel.close();
  }, [paper]);

  useEffect(() => {
    const { path, text } = active;
    if (editorPreviews !== false || !format || path === null || text === null) return;
    const mine = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/v1/pages/render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, format }),
        });
        if (mine !== seq.current) return;
        if (res.status === 401) {
          setProblem('Sign in to see the preview.');
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        setRendered({ path, html: ((await res.json()) as { html: string }).html });
        setProblem(null);
      } catch {
        if (mine === seq.current) setProblem('The preview could not be made just now.');
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [active, format, editorPreviews]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule px-6 pb-1.5 font-sans text-[13px] narrow:px-4">
        <span className="text-muted">
          Editing in {editorName}. Your changes stay in this browser until you commit them in Source Control.
        </span>
        <span className="flex-1" />
        {committed && (
          <a href={pagePath} className="text-accent">
            Committed: see the page
          </a>
        )}
        {editorPreviews === false && (
          <button type="button" className={ui.linkBtn} onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? 'hide preview' : 'show preview'}
          </button>
        )}
        <a href={pagePath} className="text-accent">
          back to the page
        </a>
      </div>
      <div className="flex min-h-0 flex-1 narrow:flex-col">
        <iframe
          src={frameSrc}
          title={`${editorName}: the page's files`}
          className="min-h-0 min-w-0 flex-[3] border-0 narrow:min-h-[70vh]"
          allow="clipboard-read; clipboard-write"
        />
        {showPreview && editorPreviews === false && (
          <section
            aria-label="Preview"
            className="min-h-0 flex-[2] overflow-y-auto border-l border-rule px-6 py-4 narrow:border-t narrow:border-l-0"
          >
            <p className={`${ui.fine} mb-3 font-sans`}>
              {active.path ? (
                <>
                  Preview of <code className={ui.mono}>{active.path}</code>
                </>
              ) : (
                'Preview'
              )}
            </p>
            {format ? (
              <div className="md font-serif text-[15px]">
                {problem && <p className="text-muted italic">{problem}</p>}
                {html !== null && (
                  <>
                    <PreviewHtml html={html} />
                    <DemoFrames watch={html} />
                  </>
                )}
              </div>
            ) : (
              <p className="font-sans text-sm text-muted">
                Open a section in <code className={ui.mono}>community/</code> or{' '}
                <code className={ui.mono}>author/</code> to see it here as the page will show it.
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
