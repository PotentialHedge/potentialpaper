'use client';

import { useEffect, useId, useState } from 'react';
import { ui } from './ui';

export interface HandleMatch {
  handle: string;
  institution: string | null;
}

/**
 * Picking an account by handle from a list (`GET /api/v1/handles`), so a mistyped or unknown handle can't be chosen:
 * typing searches, and only a row picked from the list (by click, or arrows and Enter) is a choice. An ARIA combobox.
 */
export function HandleCombobox({
  value,
  onChange,
  autoFocus,
}: {
  /** The picked account, or `null` while none is. */
  value: HandleMatch | null;
  onChange: (match: HandleMatch | null) => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(value ? `@${value.handle}` : '');
  const [matches, setMatches] = useState<HandleMatch[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = text.trim().replace(/^@/, '');

  useEffect(() => {
    if (!q || value) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/v1/handles?${new URLSearchParams({ q })}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : { accounts: [] }))
        .then((body: { accounts: HandleMatch[] }) => {
          setMatches(body.accounts);
          setActive(0);
        })
        .catch(() => {});
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, value]);

  const shown = q && !value ? (matches ?? []) : [];
  const pick = (match: HandleMatch) => {
    onChange(match);
    setText(`@${match.handle}`);
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        role="combobox"
        aria-expanded={open && shown.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${id}-${active}` : undefined}
        aria-label="Their handle"
        placeholder="Search their handle, e.g. @ada"
        autoComplete="off"
        autoFocus={autoFocus}
        value={text}
        maxLength={65}
        className={ui.input}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (value) onChange(null);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            if (shown.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
          } else if (e.key === 'Enter' && open && shown[active]) {
            e.preventDefault();
            pick(shown[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && q && !value && matches && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 -mt-px max-h-60 overflow-auto border border-frame bg-card shadow-sm"
        >
          {shown.length === 0 ? (
            <li className="px-2 py-1.5 text-muted">Nobody here has that handle.</li>
          ) : (
            shown.map((m, i) => (
              <li
                key={m.handle}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                // Before the input's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-2 py-1.5 ${i === active ? 'bg-rule-soft' : ''}`}
              >
                @{m.handle}
                {m.institution && <span className="text-muted"> · {m.institution}</span>}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
