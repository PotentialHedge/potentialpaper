'use client';

import * as D from '@radix-ui/react-dialog';
import { useState, type ComponentProps } from 'react';

/**
 * A modal on a wide screen and a bottom sheet on a phone (`narrow`), copied from acceptodds' `SheetContent`: Radix's
 * dialog, which traps focus, closes on Escape and on the backdrop, and locks page scroll. On a phone it is pinned to
 * the bottom edge, slides up, and closes when its handle is dragged down. It sets no heading of its own: the children
 * place a `SheetTitle` where their design wants it.
 */
export const Sheet = D.Root;
export const SheetTrigger = D.Trigger;
/** Closes the sheet when its child is used (`asChild`). */
export const SheetClose = D.Close;
/** The sheet's accessible name. */
export const SheetTitle = D.Title;

/** How far a sheet must be dragged down, in px, to close. */
const DISMISS_DRAG = 80;

/** The sheet itself. `onDismiss` closes the controlled `Sheet`, for the drag. */
export function SheetContent({
  onDismiss,
  className = '',
  children,
  ...props
}: ComponentProps<typeof D.Content> & { onDismiss: () => void }) {
  const [drag, setDrag] = useState<{ start: number; dy: number } | null>(null);
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
      <D.Content
        aria-describedby={undefined}
        className={`fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-frame bg-card p-6 text-left font-sans text-sm shadow-sm outline-none narrow:top-auto narrow:bottom-0 narrow:left-0 narrow:max-h-[92dvh] narrow:w-full narrow:translate-x-0 narrow:translate-y-0 narrow:animate-sheet-up narrow:rounded-t-2xl narrow:border-x-0 narrow:border-b-0 narrow:px-5 narrow:pt-0 narrow:pb-[max(1.25rem,env(safe-area-inset-bottom))] motion-reduce:animate-none ${className}`}
        style={{
          transform: drag ? `translateY(${drag.dy}px)` : undefined,
          transition: drag ? 'none' : 'transform 0.2s ease-out',
        }}
        {...props}
      >
        <div
          aria-hidden="true"
          className="hidden cursor-grab touch-none py-3 narrow:block"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ start: event.clientY, dy: 0 });
          }}
          onPointerMove={(event) => {
            if (drag) setDrag({ start: drag.start, dy: Math.max(0, event.clientY - drag.start) });
          }}
          onPointerUp={() => {
            if (drag && drag.dy > DISMISS_DRAG) onDismiss();
            setDrag(null);
          }}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="mx-auto h-1 w-10 rounded-full bg-rule-strong" />
        </div>
        <D.Close
          aria-label="Close"
          className="absolute top-3 right-3 cursor-pointer px-1 text-lg leading-none text-muted hover:text-ink narrow:hidden"
        >
          ×
        </D.Close>
        {children}
      </D.Content>
    </D.Portal>
  );
}
