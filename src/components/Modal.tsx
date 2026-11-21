'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { ui } from './ui';

/**
 * A modal in the site's look, as the Edit dialog (`components/pages/EditDialog.tsx`) draws one: a native `<dialog>`,
 * which handles focus, Escape and the backdrop. Open while `open`; Escape, "close" or a click on the backdrop call
 * `onClose`. Focus starts on the element marked `data-autofocus`, if any.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // The dialog focuses its first control ("close"); a field marked `data-autofocus` is the better start.
      d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
      aria-labelledby={titleId}
      className="m-auto w-[min(560px,calc(100vw-32px))] border border-frame bg-card p-0 text-left font-sans text-sm text-ink shadow-sm backdrop:bg-black/30"
    >
      {open && (
        <div className="p-5">
          <div className="flex items-baseline">
            <h2 id={titleId} className={ui.boxHeading}>
              {title}
            </h2>
            <span className="flex-1" />
            <button type="button" className={ui.linkBtn} onClick={onClose} aria-label="Close">
              close
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
