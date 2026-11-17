'use client';

import * as C from '@radix-ui/react-checkbox';
import type { ComponentProps, ReactNode } from 'react';

function Tick() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="size-3">
      <path d="M2.5 6.2 5 8.6l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A box to tick: Radix's primitive, square and in the accent when ticked. */
export function Checkbox({
  checked,
  onCheckedChange,
  className = '',
  ...props
}: Omit<ComponentProps<typeof C.Root>, 'checked' | 'onCheckedChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <C.Root
      checked={checked}
      onCheckedChange={(c) => onCheckedChange(c === true)}
      className={`inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[3px] border border-rule-strong bg-card text-white transition-colors hover:border-frame focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frame disabled:cursor-default disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent ${className}`}
      {...props}
    >
      <C.Indicator>
        <Tick />
      </C.Indicator>
    </C.Root>
  );
}

/** A checkbox with its label beside it, the whole line a target. */
export function CheckboxField({
  label,
  hint,
  ...props
}: ComponentProps<typeof Checkbox> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 py-0.5">
      <Checkbox className="mt-[3px]" {...props} />
      <span>
        {label}
        {hint && <span className="block text-xs text-faint">{hint}</span>}
      </span>
    </label>
  );
}
