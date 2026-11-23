'use client';

import { type FormEvent, useId, useState } from 'react';
import { Modal } from '@/components/Modal';
import { ui } from '@/components/ui';
import { failureOf, send } from './api';
import { useCategoryMatches } from './useCategoryMatches';

/**
 * "Add to a category", in the Categories box in every page's sidebar (`components/pages/common.tsx`): a category by name,
 * offered from the categories there are as one types; one no category has is made. Adds an `in-category` link from the page, as
 * the reader's own edit of its links (`POST /api/v1/pages/{identifier}/categories`), as a Wikipedia page is put in a
 * category.
 */
export function AddCategory({
  identifier,
  label,
  className = ui.linkBtn,
}: {
  identifier: string;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const matches = useCategoryMatches(chosen ? '' : name);
  const exact = matches.find((m) => m.exact);
  const listId = useId();
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  // The list under the field: the categories like what is typed, then, when none has that name, making it.
  const typed = name.trim();
  const rows: ({ identifier: string; name: string } | null)[] =
    chosen || typed.length < 2 ? [] : [...matches.slice(0, 8), ...(exact ? [] : [null])];
  const showList = listOpen && rows.length > 0;
  const pick = (row: { identifier: string; name: string } | null) => {
    if (row) {
      setChosen(row.identifier);
      setName(row.name);
    }
    setListOpen(false);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const category = chosen ?? exact?.identifier;
      const res = await send('POST', `/pages/${encodeURIComponent(identifier)}/categories`, {
        ...(category ? { category } : { name: name.trim() }),
      });
      if (!res.ok) return setNote({ ok: false, text: (await failureOf(res)).message });
      const body = (await res.json()) as {
        category: { name: string; address: string };
        created: boolean;
        status: string;
      };
      setNote({
        ok: true,
        text:
          body.status === 'exists'
            ? `It is in ${body.category.name} already.`
            : body.created
              ? `Made the category ${body.category.name} and added this page to it. It shows here within a few minutes.`
              : `Added to ${body.category.name}. It shows here within a few minutes.`,
        link: body.category.address,
      });
      setName('');
      setChosen(null);
    } catch {
      setNote({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          setNote(null);
          setOpen(true);
        }}
      >
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add to a category">
        {form()}
      </Modal>
    </>
  );

  function form() {
    return (
      <form onSubmit={submit} className="mt-3">
        <input
          data-autofocus
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setChosen(null);
            setActive(0);
            setListOpen(true);
          }}
          onFocus={() => setListOpen(true)}
          onBlur={() => setListOpen(false)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setListOpen(true);
              if (rows.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
            } else if (e.key === 'Enter' && showList) {
              e.preventDefault();
              pick(rows[active] ?? null);
            } else if (e.key === 'Escape' && showList) {
              e.preventDefault();
              e.stopPropagation();
              setListOpen(false);
            }
          }}
          required
          maxLength={120}
          placeholder="A category, such as Linear attention"
          aria-label="Category"
          className={`${ui.input} w-full`}
        />
        {showList && (
          <ul id={listId} role="listbox" className="-mt-px mb-2 max-h-60 overflow-auto border border-frame bg-card">
            {rows.map((row, i) => (
              <li
                key={row?.identifier ?? ''}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // Before the field's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(row);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-2 py-1.5 ${i === active ? 'bg-rule-soft' : ''}`}
              >
                {row ? row.name : <span className="text-muted">Make a new category “{typed}”</span>}
              </li>
            ))}
          </ul>
        )}
        {typed.length > 1 && !chosen && !exact && !showList && (
          <p className="mb-2 text-xs text-muted">No category is called that yet: adding makes it.</p>
        )}
        <button className={ui.btn({ inline: true })} disabled={busy || !name.trim()}>
          Add
        </button>
        {note && (
          <p className={ui.note(note.ok)}>
            {note.text}
            {note.link && (
              <>
                {' '}
                <a href={note.link}>Open the category</a>
              </>
            )}
          </p>
        )}
      </form>
    );
  }
}
