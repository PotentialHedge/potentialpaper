'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, LinkIcon } from '@/components/icons';
import { ui } from '@/components/ui';

/** The anchor the address bar names, if any. */
function hash(): string {
  return decodeURIComponent(location.hash.slice(1));
}

/** Calls `follow` now and whenever the address bar's anchor changes. */
function useHash(follow: (id: string) => void, deps: unknown[]) {
  useEffect(() => {
    const run = () => follow(hash());
    run();
    window.addEventListener('hashchange', run);
    return () => window.removeEventListener('hashchange', run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * A link to `#anchor` on this page, marked with a chain icon. A plain click also copies the full URL and says
 * "Link copied" for a moment; it still goes to the anchor, so the address bar shows it too. Clicks with a
 * modifier (new tab, etc.) are left to the browser.
 */
export function Permalink({ anchor, kind, children }: { anchor: string; kind: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <a
      href={`#${anchor}`}
      className="inline-flex items-baseline gap-1 text-muted hover:text-accent hover:underline"
      title={copied ? 'Link copied' : `Copy a link to this ${kind}`}
      onClick={async (event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const url = new URL(window.location.href);
        url.hash = anchor;
        try {
          await navigator.clipboard.writeText(url.toString());
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // No clipboard: the address bar has the link.
        }
      }}
    >
      {children}
      {copied ? (
        <CheckIcon className="size-[1em] self-center text-accent" />
      ) : (
        <LinkIcon className="size-[1em] self-center" />
      )}
      <span aria-live="polite" className="text-accent empty:hidden">
        {copied ? 'Link copied' : ''}
      </span>
    </a>
  );
}

/** A note's writing behind `summary`. A link to the note (`#anchor`) opens it: the reader came to read it. */
export function LinkedDetails({ anchor, summary, children }: { anchor: string; summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useHash((id) => id === anchor && setOpen(true), [anchor]);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="mt-2">
      <summary className="cursor-pointer font-sans text-[13px] text-accent">{summary}</summary>
      {children}
    </details>
  );
}

/** Comments shown before "Show N more". */
const SHOWN = 3;

/**
 * The comments under a note (or on the paper): behind "N comments", the first {@link SHOWN} once opened and
 * the rest behind "Show N more". `items` are rendered on the server, one per anchor in `anchors`. A link to one
 * of them opens the list as far as needed and scrolls to it, outlined: the browser can't, as it was hidden.
 */
export function LinkedComments({ anchors, items }: { anchors: string[]; items: ReactNode[] }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const target = useRef<string | null>(null);

  // Before the effect that sets `target`, so it scrolls only after the render that shows the comment.
  useEffect(() => {
    if (!target.current) return;
    // Marked by hand: `:target` only matches an element that was there when the page arrived.
    for (const el of document.querySelectorAll('[data-linked]')) el.removeAttribute('data-linked');
    const el = document.getElementById(target.current);
    el?.setAttribute('data-linked', '');
    el?.scrollIntoView({ block: 'start' });
    target.current = null;
  }, [open, all]);

  useHash(
    (id) => {
      const i = anchors.indexOf(id);
      if (i < 0) return;
      setOpen(true);
      if (i >= SHOWN) setAll(true);
      target.current = id;
    },
    [anchors.join()],
  );

  // One more is shown rather than hidden behind a button of its own.
  const hidden = items.length > SHOWN + 1 ? items.length - SHOWN : 0;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="mt-2">
      <summary className="cursor-pointer font-sans text-[13px] text-accent">
        {items.length === 1 ? '1 comment' : `${items.length} comments`}
      </summary>
      {all || hidden === 0 ? items : items.slice(0, SHOWN)}
      {!all && hidden > 0 && (
        <button type="button" className={`${ui.linkBtn} mt-3 font-sans text-[13px]`} onClick={() => setAll(true)}>
          Show {hidden} more {hidden === 1 ? 'comment' : 'comments'}
        </button>
      )}
    </details>
  );
}
