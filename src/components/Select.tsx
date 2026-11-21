import type { SelectHTMLAttributes } from 'react';
import { ChevronDownIcon } from './icons';

/**
 * A select in the site's look: the same box, height and type as a text field (`ui.input`), with its own arrow, since
 * the browser's own select ignores the field's border and padding. A required select still on its empty first option
 * reads like a placeholder. `className` sizes and places the box (default: full width, `mb-2` as a field has);
 * `compact` is the smaller box beside filters.
 */
export function Select({
  className = 'mb-2 w-full',
  compact = false,
  children,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'> & { className?: string; compact?: boolean }) {
  return (
    <span className={`relative inline-block align-middle ${className}`}>
      <select
        {...props}
        className={`w-full cursor-pointer appearance-none border border-rule bg-white font-sans text-sm leading-[normal] text-ink invalid:text-faint narrow:text-base ${compact ? 'py-1 pr-6 pl-1.5' : 'py-1.5 pr-7 pl-1.5'}`}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-muted" />
    </span>
  );
}
