'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ui } from '@/components/ui';

/** The sections this browser keeps folded, by id, on every paper: fold Versions once and it stays folded. */
const KEY = 'pp.folded';

function folded(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * One of a paper page's sections, with its heading's title a toggle that folds the rest away. Open on the
 * server's render; a section folded before folds once the page is up. Folded, the body is hidden, not
 * unmounted, so a comment being written survives it. A link into the section (`#id` or an anchor inside it)
 * unfolds it.
 */
export function Fold({
  id,
  title,
  extra,
  children,
}: {
  id: string;
  title: ReactNode;
  /** After the title in the heading: its edit and history links. */
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  // Folding on load moves what is below: the spot the address bar links to, scrolled to already, is found again.
  const rescroll = useRef(false);

  useEffect(() => {
    if (!rescroll.current) return;
    rescroll.current = false;
    const target = decodeURIComponent(location.hash.slice(1));
    if (target) document.getElementById(target)?.scrollIntoView({ block: 'start' });
  }, [open]);

  useEffect(() => {
    const follow = () => {
      const target = decodeURIComponent(location.hash.slice(1));
      const linked =
        target && (target === id || document.getElementById(id)?.querySelector(`[id="${CSS.escape(target)}"]`));
      const next = linked ? true : !folded().includes(id);
      setOpen((was) => {
        if (was && !next) rescroll.current = true;
        return next;
      });
    };
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    try {
      const rest = folded().filter((x) => x !== id);
      localStorage.setItem(KEY, JSON.stringify(next ? rest : [...rest, id]));
    } catch {
      // No storage: it folds for now only.
    }
  }

  return (
    <section id={id}>
      <h2 className={ui.groupHeading}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={toggle}
          className="cursor-pointer text-left [font:inherit] [font-variant-caps:inherit] hover:text-accent"
        >
          {title}
          <span
            aria-hidden
            className={`ml-1.5 inline-block font-sans text-sm text-faint transition-transform ${open ? 'rotate-90' : ''}`}
          >
            ›
          </span>
        </button>
        {extra}
      </h2>
      <div id={`${id}-body`} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
