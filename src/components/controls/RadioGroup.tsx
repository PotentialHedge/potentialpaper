'use client';

import * as R from '@radix-ui/react-radio-group';
import type { ReactNode } from 'react';

export interface Option<V extends string = string> {
  value: V;
  label: ReactNode;
  /** A line under the label. */
  hint?: ReactNode;
  disabled?: boolean;
}

/**
 * One of a few choices, each a round button with its label: Radix's primitive, so the arrow keys move between them
 * and Tab leaves the group.
 */
export function RadioGroup<V extends string>({
  options,
  value,
  onValueChange,
  label,
  disabled,
  className = '',
}: {
  options: Option<V>[];
  value: V | null;
  onValueChange: (value: V) => void;
  /** Names the group for assistive tech. */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <R.Root
      value={value ?? ''}
      onValueChange={(v) => onValueChange(v as V)}
      aria-label={label}
      disabled={disabled}
      className={`flex flex-col gap-1 ${className}`}
    >
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2 py-0.5">
          <R.Item
            value={o.value}
            disabled={o.disabled}
            className="mt-[3px] inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full border border-rule-strong bg-card hover:border-frame focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frame disabled:cursor-default disabled:opacity-50 data-[state=checked]:border-accent"
          >
            <R.Indicator className="block size-2 rounded-full bg-accent" />
          </R.Item>
          <span>
            {o.label}
            {o.hint && <span className="block text-xs text-faint">{o.hint}</span>}
          </span>
        </label>
      ))}
    </R.Root>
  );
}
