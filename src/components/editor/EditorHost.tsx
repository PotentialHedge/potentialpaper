'use client';

import { useEffect, useState } from 'react';
import { ui } from '@/components/ui';
import { editorChannelName, type EditorMessage, type HostMessage } from '@/editors/channel';
import type { PageRef } from '@/lib/kinds';

/**
 * The page around a web editor (`src/editors`): the editor in a frame, which previews sections itself. Knows
 * nothing of which editor it is: the editor tells it when it has loaded and committed through the channel
 * (`src/editors/channel.ts`).
 */

export function EditorHost({
  page,
  frameSrc,
  editorName,
  pagePath,
}: {
  page: PageRef;
  frameSrc: string;
  editorName: string;
  pagePath: string;
}) {
  const [committed, setCommitted] = useState(false);
  /** The editor has loaded the page's files (its `ready`); until then a notice covers its frame. */
  const [ready, setReady] = useState(false);
  /** Loading has taken long enough to say so. */
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const channel = new BroadcastChannel(editorChannelName({ scheme: page.scheme, value: page.value }));
    channel.onmessage = (event: MessageEvent<EditorMessage>) => {
      const message = event.data;
      if (message?.type === 'ready') setReady(true);
      if (message?.type === 'committed') setCommitted(true);
    };
    channel.postMessage({ type: 'hello' } satisfies HostMessage);
    const timer = setTimeout(() => setSlow(true), 20_000);
    return () => {
      channel.close();
      clearTimeout(timer);
    };
  }, [page.scheme, page.value]);

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
        <a href={pagePath} className="text-accent">
          back to the page
        </a>
      </div>
      <div className="flex min-h-0 flex-1 narrow:flex-col">
        <div className="relative flex min-h-0 min-w-0 flex-[3] narrow:min-h-[70vh]">
          <iframe
            src={frameSrc}
            title={`${editorName}: the page's files`}
            className="min-h-0 min-w-0 flex-1 border-0"
            allow="clipboard-read; clipboard-write"
          />
          {!ready && (
            <div
              role="status"
              className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg font-sans text-sm text-muted"
            >
              <span
                aria-hidden
                className="size-6 animate-spin rounded-full border-2 border-rule-strong border-t-accent"
              />
              <span>Loading {editorName} and the page&apos;s files…</span>
              {slow && (
                <span className="max-w-sm text-center text-xs">
                  This is taking a while. The first time, the editor has a lot to download; if nothing changes,{' '}
                  <button type="button" className={ui.linkBtn} onClick={() => window.location.reload()}>
                    reload the page
                  </button>
                  .
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
