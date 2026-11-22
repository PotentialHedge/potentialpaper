'use client';

import { type FormEvent, useState } from 'react';
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
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setChosen(null);
          }}
          required
          maxLength={120}
          placeholder="A category, such as Linear attention"
          aria-label="Category"
          className={ui.input}
        />
        {matches.length > 0 && (
          <ul className="mb-2 space-y-0.5">
            {matches.slice(0, 6).map((m) => (
              <li key={m.key}>
                <button
                  type="button"
                  className={ui.linkBtn}
                  onClick={() => {
                    setChosen(m.identifier);
                    setName(m.name);
                  }}
                >
                  {m.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {name.trim().length > 1 && !chosen && !exact && (
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
