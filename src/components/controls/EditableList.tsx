'use client';

import { useState } from 'react';
import { ui } from '@/components/ui';
import { fieldClass, iconButtonClass } from './fields';
import type { Option } from './RadioGroup';
import { Select } from './Select';
import { SortableList } from './SortableList';

/**
 * An ordered list of different strings to add to, remove from, edit and reorder (drag, or the arrows), as VS Code's
 * array settings are. With `options`, items are picked from them; without, typed (and edited with the pencil, or a
 * double-click).
 */
export function EditableList({
  value,
  onChange,
  label,
  options,
  maxItems,
  maxLength,
  placeholder,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  label: string;
  options?: Option[];
  maxItems?: number;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ at: number; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const labelOf = (v: string) => {
    const l = options?.find((o) => o.value === v)?.label;
    return typeof l === 'string' ? l : v;
  };
  const left = options?.filter((o) => !value.includes(o.value)) ?? [];
  const full = maxItems !== undefined && value.length >= maxItems;

  function check(text: string, except: number | null): string | null {
    if (!text) return 'Type something first.';
    if (maxLength !== undefined && text.length > maxLength) return `At most ${maxLength} characters.`;
    if (value.some((v, i) => v === text && i !== except)) return `“${text}” is in the list already.`;
    return null;
  }

  function add(text: string) {
    const why = check(text.trim(), null);
    setProblem(why);
    if (why) return;
    onChange([...value, text.trim()]);
    setAdding('');
  }

  function saveEdit() {
    if (!editing) return;
    const text = editing.text.trim();
    const why = check(text, editing.at);
    setProblem(why);
    if (why) return;
    setEditing(null);
    if (text !== value[editing.at]) onChange(value.map((v, i) => (i === editing.at ? text : v)));
  }

  const startEdit = (at: number) => !options && !disabled && setEditing({ at, text: value[at] });

  return (
    <div>
      <SortableList
        items={value}
        getId={(v) => v}
        getLabel={labelOf}
        onReorder={onChange}
        label={label}
        disabled={disabled}
        renderItem={(v, i) =>
          editing?.at === i ? (
            <input
              autoFocus
              aria-label={`Edit ${v}`}
              className={`${fieldClass} my-0.5 w-full`}
              value={editing.text}
              maxLength={maxLength}
              onChange={(e) => setEditing({ at: i, text: e.target.value })}
              onBlur={saveEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEdit();
                if (e.key === 'Escape') {
                  setEditing(null);
                  setProblem(null);
                }
              }}
            />
          ) : (
            <span className="block" onDoubleClick={() => startEdit(i)}>
              {labelOf(v)}
            </span>
          )
        }
        actions={(v, i) => (
          <>
            {!options && (
              <button
                type="button"
                className={iconButtonClass}
                disabled={disabled}
                aria-label={`Edit ${labelOf(v)}`}
                onClick={() => startEdit(i)}
              >
                ✎
              </button>
            )}
            <button
              type="button"
              className={iconButtonClass}
              disabled={disabled}
              aria-label={`Remove ${labelOf(v)}`}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              ✕
            </button>
          </>
        )}
      />
      {!full && options && left.length > 0 && (
        <div className="mt-2">
          {/* Picking a choice adds it at once: there is nothing more to type. */}
          <Select
            options={left}
            value=""
            onValueChange={(v) => onChange([...value, v])}
            label={`Add to ${label}`}
            placeholder="Add an item…"
            disabled={disabled}
          />
        </div>
      )}
      {!full && !options && (
        <form
          className="mt-2 flex max-w-[520px] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add(adding);
          }}
        >
          <input
            className={`${fieldClass} min-w-0 flex-1`}
            aria-label={`Add to ${label}`}
            disabled={disabled}
            value={adding}
            maxLength={maxLength}
            placeholder={placeholder ?? 'Add an item'}
            onChange={(e) => {
              setAdding(e.target.value);
              setProblem(null);
            }}
          />
          <button
            type="submit"
            className={`${ui.btn({ ghost: true, inline: true, flush: true })} border border-rule px-3`}
            disabled={disabled || !adding.trim()}
          >
            Add item
          </button>
        </form>
      )}
      {full && <p className={`${ui.fine} mt-1`}>The list is full: at most {maxItems} items.</p>}
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </div>
  );
}
