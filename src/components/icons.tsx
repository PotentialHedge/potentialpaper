/** Three dots: a menu of the rarer choices. */
export function MoreIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <circle cx="4" cy="10" r="1.75" />
      <circle cx="10" cy="10" r="1.75" />
      <circle cx="16" cy="10" r="1.75" />
    </svg>
  );
}

/** A funnel: the filters, folded into one menu on a phone. */
export function FilterIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z" />
    </svg>
  );
}

/** A magnifying glass: a search field's mark. */
export function SearchIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className={className}
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5 14 14" />
    </svg>
  );
}

/** A link or button with its icon beside its word. */
export const WITH_ICON = 'inline-flex items-center gap-1';

/** Stroked 16px line icons share these, so they sit at one weight beside text. */
const line = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

/** A closing quotation mark: cite. */
export function QuoteIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...line} className={className}>
      <path d="M3 9.5h3.5V13H3V9.5c0-2.5 1-4.5 3-5.5M9.5 9.5H13V13H9.5V9.5c0-2.5 1-4.5 3-5.5" />
    </svg>
  );
}

/** A pencil: edit. */
export function PencilIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...line} className={className}>
      <path d="M10.5 2.5l3 3L5.5 13.5H2.5v-3zM9 4l3 3" />
    </svg>
  );
}

/** A clock with a turning-back arrow: history. */
export function HistoryIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...line} className={className}>
      <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5" />
    </svg>
  );
}

/** An eye: how many have viewed a page. */
export function EyeIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...line} className={className}>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

/** A star: follow a paper. Filled when followed. */
export function StarIcon({ className = 'size-3.5', filled = false }: { className?: string; filled?: boolean }) {
  return (
    <svg {...line} fill={filled ? 'currentColor' : 'none'} className={className}>
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
    </svg>
  );
}

/** A terminal prompt: the page for AI agents. */
export function AgentIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...line} className={className}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5L6.5 8l-2 1.5M8 10h3" />
    </svg>
  );
}

/** An arrow out of a tray: share. */
export function ShareIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg {...line} className={className}>
      <path d="M8 10V2M5 4.5L8 1.5l3 3M4.5 7H3v6.5h10V7h-1.5" />
    </svg>
  );
}

/** Two chain links: a link to this spot on the page. */
export function LinkIcon({ className = 'size-[1em]' }: { className?: string }) {
  return (
    <svg {...line} className={className}>
      <path d="M6.75 9.25a2.5 2.5 0 0 0 3.54 0l2.5-2.5a2.5 2.5 0 0 0-3.54-3.54l-.75.75" />
      <path d="M9.25 6.75a2.5 2.5 0 0 0-3.54 0l-2.5 2.5a2.5 2.5 0 0 0 3.54 3.54l.75-.75" />
    </svg>
  );
}

/** A tick: done, e.g. copied. */
export function CheckIcon({ className = 'size-[1em]' }: { className?: string }) {
  return (
    <svg {...line} strokeWidth={1.75} className={className}>
      <path d="M3 8.5l3.25 3.25L13 4.5" />
    </svg>
  );
}

export function ChevronDownIcon({ className = 'size-3' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <path d="M2.5 4.5 6 8l3.5-3.5" />
    </svg>
  );
}
