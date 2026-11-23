'use client';

import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { ui } from '@/components/ui';
import { useCategoryMatches } from './useCategoryMatches';

export interface CategoryOption {
  slug: string;
  name: string;
}

/**
 * The home page's category filter: an ARIA combobox. Empty, it offers the categories with the most papers; typed
 * into, the categories like what is typed (`GET /api/v1/categories?q=`). Picking one (click, or arrows and Enter)
 * goes to `base` with `?category=<slug>`; "all categories" goes to `base` as it is.
 */
export function CategoryFilter({
  base,
  current,
  top,
}: {
  /** The search as it is, without a category. */
  base: string;
  current: CategoryOption | null;
  top: CategoryOption[];
}) {
  const id = useId();
  const router = useRouter();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useCategoryMatches(text);
  const options: CategoryOption[] = text.trim().length >= 2 ? matches.map((m) => ({ slug: m.key, name: m.name })) : top;
  const rows: (CategoryOption | null)[] = current ? [null, ...options] : options;

  const go = (option: CategoryOption | null) => {
    setOpen(false);
    setText('');
    const url = new URL(base, window.location.origin);
    if (option) url.searchParams.set('category', option.slug);
    router.push(`${url.pathname}${url.search}`);
    // Close the menu it is in, as picking a link there does.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  };

  return (
    <div className="relative">
      <input
        role="combobox"
        aria-expanded={open && rows.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[active] !== undefined ? `${id}-${active}` : undefined}
        aria-label="Category"
        placeholder={current ? current.name : 'Any category'}
        autoComplete="off"
        value={text}
        maxLength={120}
        className={`${ui.input} w-full ${current ? 'placeholder:text-ink' : ''}`}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
            if (rows.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (open && rows[active] !== undefined) go(rows[active]);
          } else if (e.key === 'Escape' && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          id={`${id}-list`}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 -mt-px max-h-60 overflow-auto border border-frame bg-card text-[13px] shadow-sm"
        >
          {rows.length === 0 ? (
            <li className="px-2 py-1.5 text-muted">
              {text.trim().length >= 2 ? 'No category is called that.' : 'No categories yet.'}
            </li>
          ) : (
            rows.map((option, i) => (
              <li
                key={option?.slug ?? ''}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                // Before the input's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(option);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-2 py-1.5 ${i === active ? 'bg-rule-soft' : ''} ${
                  option && option.slug === current?.slug ? 'font-semibold' : ''
                } ${option ? '' : 'text-muted'}`}
              >
                {option ? option.name : 'All categories'}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
