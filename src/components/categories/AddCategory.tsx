'use client';

import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/Modal';
import { ui } from '@/components/ui';
import { failureOf, send } from './api';
import { useCategoryMatches } from './useCategoryMatches';

/** A category picked in the field: one there is (`identifier`), or a new one by `name`. */
interface Picked {
  identifier: string | null;
  name: string;
}

/**
 * "Add to a category", in the Categories box in every page's sidebar (`components/pages/common.tsx`). A field like a
 * tag input: typing offers the categories there are in a list over the form (an ARIA combobox), and each one picked,
 * or a new one by its name, becomes a tag. "Add" puts the page in each (`POST /api/v1/pages/{identifier}/categories`,
 * one `in-category` link apiece, as the reader's own edit), making the new ones, as a Wikipedia page is put in
 * categories.
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<{ ok: boolean; text: string; link?: string }[]>([]);
  const listId = useId();
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const typed = text.trim();
  const matches = useCategoryMatches(text);
  const pickedKey = (p: Picked) => p.identifier ?? `new:${p.name.toLowerCase()}`;
  const taken = new Set(picked.map(pickedKey));
  const exact = matches.some((m) => m.exact);
  // The categories like what is typed and not picked yet, then, when none has that name, making it.
  const rows: Picked[] =
    typed.length < 2
      ? []
      : [
          ...matches
            .filter((m) => !taken.has(m.identifier))
            .slice(0, 8)
            .map((m) => ({ identifier: m.identifier, name: m.name })),
          ...(exact || taken.has(`new:${typed.toLowerCase()}`) ? [] : [{ identifier: null, name: typed }]),
        ];
  const showList = listOpen && rows.length > 0;
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // The list is a popover, in the top layer over the modal (which would clip it), placed under the field.
  useEffect(() => {
    const ul = list.current;
    const field = box.current;
    if (!showList || !ul || !field) return;
    const place = () => {
      const r = field.getBoundingClientRect();
      Object.assign(ul.style, { top: `${r.bottom - 1}px`, left: `${r.left}px`, width: `${r.width}px` });
    };
    place();
    if (!ul.matches(':popover-open')) ul.showPopover();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (ul.matches(':popover-open')) ul.hidePopover();
    };
  }, [showList]);

  const pick = (row: Picked) => {
    setPicked((list) => [...list, row]);
    setText('');
    setActive(0);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (picked.length === 0) return;
    setBusy(true);
    setNotes([]);
    const left: Picked[] = [];
    const out: typeof notes = [];
    for (const p of picked) {
      try {
        const res = await send('POST', `/pages/${encodeURIComponent(identifier)}/categories`, {
          ...(p.identifier ? { category: p.identifier } : { name: p.name }),
        });
        if (!res.ok) {
          left.push(p);
          out.push({ ok: false, text: `${p.name}: ${(await failureOf(res)).message}` });
          continue;
        }
        const body = (await res.json()) as {
          category: { name: string; address: string };
          created: boolean;
          status: string;
        };
        out.push({
          ok: true,
          text:
            body.status === 'exists'
              ? `It is in ${body.category.name} already.`
              : body.created
                ? `Made ${body.category.name} and added this page.`
                : `Added to ${body.category.name}.`,
          link: body.category.address,
        });
      } catch {
        left.push(p);
        out.push({ ok: false, text: `${p.name}: could not reach the server.` });
      }
    }
    setPicked(left);
    setNotes(out);
    setBusy(false);
    // Show it in the Categories box behind the modal.
    if (out.some((n) => n.ok)) router.refresh();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setListOpen(true);
      if (rows.length > 0) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (e.key === 'Enter' && showList) {
      // Enter picks; with nothing typed, it sends the form.
      e.preventDefault();
      pick(rows[active] ?? rows[0]);
    } else if (e.key === 'Enter' && typed) {
      e.preventDefault();
    } else if (e.key === 'Backspace' && !text && picked.length > 0) {
      setPicked((list) => list.slice(0, -1));
    } else if (e.key === 'Escape' && showList) {
      e.preventDefault();
      e.stopPropagation();
      setListOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          setNotes([]);
          setOpen(true);
        }}
      >
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Add to categories">
        <form onSubmit={submit} className="mt-3">
          <div>
            {/* The tags and the field, as one box. */}
            <div
              ref={box}
              className="flex flex-wrap items-center gap-1.5 border border-rule bg-card px-1.5 py-1 focus-within:border-frame"
            >
              {picked.map((p, i) => (
                <span
                  key={pickedKey(p)}
                  className="inline-flex items-center gap-1 border border-rule bg-rule-soft px-1.5 py-0.5 text-[13px]"
                >
                  {p.name}
                  {!p.identifier && <span className="text-faint">(new)</span>}
                  <button
                    type="button"
                    aria-label={`Remove ${p.name}`}
                    className="cursor-pointer px-0.5 text-muted hover:text-accent"
                    onClick={() => setPicked((list) => list.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                data-autofocus
                role="combobox"
                aria-expanded={showList}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={showList ? `${listId}-${active}` : undefined}
                aria-label="Category"
                autoComplete="off"
                value={text}
                maxLength={120}
                placeholder={picked.length > 0 ? 'Another category' : 'A category, such as Linear attention'}
                className="min-w-40 flex-1 bg-transparent px-1 py-1 font-sans text-sm placeholder:text-faint focus:outline-none narrow:text-base"
                onChange={(e) => {
                  setText(e.target.value);
                  setActive(0);
                  setListOpen(true);
                }}
                onFocus={() => setListOpen(true)}
                onBlur={() => setListOpen(false)}
                onKeyDown={onKeyDown}
              />
            </div>
            {showList && (
              // Over what is below it, not pushing it down.
              <ul
                ref={list}
                id={listId}
                role="listbox"
                popover="manual"
                className="fixed inset-auto m-0 max-h-60 overflow-auto border border-frame bg-card p-0 font-sans text-sm text-ink shadow-sm"
              >
                {rows.map((row, i) => (
                  <li
                    key={pickedKey(row)}
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
                    {row.identifier ? row.name : <span className="text-muted">Make a new category “{row.name}”</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button className={ui.btn({ inline: true })} disabled={busy || picked.length === 0}>
            {picked.length > 1 ? `Add to ${picked.length} categories` : 'Add'}
          </button>
          {notes.map((note, i) => (
            <p key={i} className={ui.note(note.ok)}>
              {note.text}
              {note.link && (
                <>
                  {' '}
                  <a href={note.link}>Open it</a>
                </>
              )}
            </p>
          ))}
        </form>
      </Modal>
    </>
  );
}
