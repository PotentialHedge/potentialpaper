'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

/** An (i) after a line, opening the detail that would crowd it: on hover, and on tap or click for touch. */
export function InfoTip({ label = 'More about this', children }: { label?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A short delay on leaving, so the pointer can cross the gap into the popover.
  const hover = (next: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = next ? null : setTimeout(() => setOpen(false), 120);
    if (next) setOpen(true);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        // Hovering already opened it, so a click (or a tap, which hovers first) keeps it open, not toggles it.
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
        className="ml-1 inline-flex size-[15px] cursor-help items-center justify-center rounded-full border border-rule-strong align-[1px] font-serif text-[10px] leading-none text-muted italic hover:border-ink hover:text-ink"
      >
        i
      </PopoverTrigger>
      <PopoverContent
        align="start"
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="w-[min(340px,calc(100vw-32px))] text-xs leading-relaxed text-subtle"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
