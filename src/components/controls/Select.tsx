'use client';

import * as S from '@radix-ui/react-select';
import type { Option } from './RadioGroup';

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="size-3">
      <path d="m3 4.5 3 3 3-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A dropdown: Radix's primitive (typeahead, arrow keys, a list that stays on screen), with a trigger shaped like the
 * site's fields and a list like its popovers. `value` `''` shows the placeholder.
 */
export function Select<V extends string>({
  options,
  value,
  onValueChange,
  label,
  placeholder = 'Choose…',
  disabled,
  className = '',
}: {
  options: Option<V>[];
  value: V | '';
  onValueChange: (value: V) => void;
  /** Names it for assistive tech. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <S.Trigger
        aria-label={label}
        className={`inline-flex min-w-[200px] cursor-pointer items-center justify-between gap-3 border border-rule bg-card px-2 py-1 text-left font-sans text-sm leading-[normal] hover:border-frame focus:border-frame focus:outline-none disabled:cursor-default disabled:opacity-50 data-[placeholder]:text-faint narrow:text-base ${className}`}
      >
        <S.Value placeholder={placeholder} />
        <S.Icon className="text-muted">
          <Chevron />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          collisionPadding={16}
          className="z-50 max-h-[min(320px,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] overflow-hidden border border-frame bg-card font-sans text-sm shadow-md"
        >
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-pointer items-center py-1 pr-2 pl-6 outline-none select-none data-[disabled]:cursor-default data-[disabled]:opacity-50 data-[highlighted]:bg-highlight data-[state=checked]:font-semibold"
              >
                <S.ItemIndicator className="absolute left-1.5 text-accent">•</S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
