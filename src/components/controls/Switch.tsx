'use client';

import * as S from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';

/**
 * An on/off switch: Radix's primitive (a `button` with `role="switch"`, Space and Enter to flip it), drawn as a track
 * and a knob in the accent.
 */
export function Switch({
  checked,
  onCheckedChange,
  className = '',
  ...props
}: Omit<ComponentProps<typeof S.Root>, 'checked' | 'onCheckedChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <S.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      className={`relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-rule-strong transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frame disabled:cursor-default disabled:opacity-50 data-[state=checked]:bg-accent ${className}`}
      {...props}
    >
      <S.Thumb className="block size-[14px] translate-x-[2px] rounded-full bg-white shadow-sm transition-transform data-[state=checked]:translate-x-[16px]" />
    </S.Root>
  );
}
