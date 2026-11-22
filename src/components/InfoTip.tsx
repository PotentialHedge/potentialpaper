'use client';

import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

/** An (i) after a line, opening the detail that would crowd it: on click, so it works by touch too. */
export function InfoTip({ label = 'More about this', children }: { label?: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className="ml-1 inline-flex size-[15px] cursor-pointer items-center justify-center rounded-full border border-rule-strong align-[1px] font-serif text-[10px] leading-none text-muted italic hover:border-ink hover:text-ink"
      >
        i
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-32px))] text-xs leading-relaxed text-subtle">
        {children}
      </PopoverContent>
    </Popover>
  );
}
