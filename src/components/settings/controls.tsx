'use client';

import { type ReactNode, useId, useMemo, useState } from 'react';
import { ui } from '@/components/ui';
import type { Choice, Control } from '@/lib/settings/form';

/**
 * The settings form's standard controls (`lib/settings/form.ts` `Control`), as VS Code's settings editor draws its
 * own: a switch, a dropdown or radio buttons, a text or number field, a list to add to, remove from and reorder, a
 * box per choice, and a fixed set to put in order. Each reports a whole new value; saving is the row's.
 */

const field =
  'border border-rule bg-card px-2 py-1 font-sans text-sm leading-[normal] focus:border-frame focus:outline-none narrow:text-base';
const iconBtn =
  'inline-flex size-6 cursor-pointer items-center justify-center text-muted hover:bg-rule-soft hover:text-ink disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent';

/** A switch: an `<input type="checkbox" role="switch">`, drawn as a track and a knob. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      className="relative mt-0.5 inline-block h-[18px] w-8 shrink-0 cursor-pointer appearance-none rounded-full bg-rule-strong transition-colors before:absolute before:top-[2px] before:left-[2px] before:size-[14px] before:rounded-full before:bg-white before:shadow-sm before:transition-transform checked:bg-accent checked:before:translate-x-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-frame disabled:cursor-default disabled:opacity-50"
    />
  );
}

function grouped(choices: Choice[]): [string, Choice[]][] {
  const out = new Map<string, Choice[]>();
  for (const c of choices) out.set(c.group ?? '', [...(out.get(c.group ?? '') ?? []), c]);
  return [...out];
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="mt-2 mb-1 text-xs tracking-wide text-faint uppercase first:mt-0">{children}</div>;
}

/** The control for one setting. `label` names it for assistive tech; the row shows it. */
export function SettingControl({
  control,
  value,
  onChange,
  label,
  disabled,
}: {
  control: Control;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  disabled?: boolean;
}) {
  switch (control.kind) {
    case 'switch':
      return <Switch checked={value === true} onChange={onChange} label={label} disabled={disabled} />;
    case 'select':
      return control.display === 'radio' ? (
        <Radios choices={control.choices} value={value} onChange={onChange} label={label} disabled={disabled} />
      ) : (
        <select
          className={`${field} min-w-[200px] pr-6`}
          aria-label={label}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        >
          {control.choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    case 'text':
      return <TextField control={control} value={value} onChange={onChange} label={label} disabled={disabled} />;
    case 'number':
      return <NumberField control={control} value={value} onChange={onChange} label={label} disabled={disabled} />;
    case 'list':
      return <ListField control={control} value={value} onChange={onChange} label={label} disabled={disabled} />;
    case 'checklist':
      return <Checklist control={control} value={value} onChange={onChange} disabled={disabled} />;
    case 'rank':
      return <Rank choices={control.choices} value={value} onChange={onChange} disabled={disabled} />;
    case 'file':
      return (
        <p className={`${ui.fine} mt-0`}>Set this one in your settings.json: download it, edit it and upload it.</p>
      );
  }
}

function Radios({
  choices,
  value,
  onChange,
  label,
  disabled,
}: {
  choices: Choice[];
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="space-y-1">
      {choices.map((c) => (
        <label key={c.value} className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={name}
            className="accent-accent"
            checked={value === c.value}
            disabled={disabled}
            onChange={() => onChange(c.value)}
          />
          {c.label}
        </label>
      ))}
    </div>
  );
}

/** A text field, saved when you leave it or press Enter (Cmd/Ctrl+Enter in a box of several lines). */
function TextField({
  control,
  value,
  onChange,
  label,
  disabled,
}: {
  control: Extract<Control, { kind: 'text' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const saved = typeof value === 'string' ? value : '';
  const shown = draft ?? saved;
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== saved) onChange(draft);
  };
  const props = {
    'aria-label': label,
    disabled,
    value: shown,
    maxLength: control.maxLength,
    placeholder: control.placeholder,
    onBlur: commit,
  };
  return control.multiline ? (
    <textarea
      {...props}
      rows={Math.min(12, Math.max(3, shown.split('\n').length + 1))}
      className={`${field} block w-full max-w-[560px]`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  ) : (
    <input
      {...props}
      className={`${field} block w-full max-w-[420px]`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** A number field, saved when you leave it or press Enter. Empty is `null` when the setting allows it. */
function NumberField({
  control,
  value,
  onChange,
  label,
  disabled,
}: {
  control: Extract<Control, { kind: 'number' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = draft ?? (typeof value === 'number' ? String(value) : '');
  const commit = () => {
    if (draft === null) return;
    const n = draft.trim() === '' ? null : Number(draft);
    const why =
      n === null
        ? control.nullable
          ? null
          : 'needs a number'
        : !Number.isFinite(n)
          ? 'needs a number'
          : control.minimum !== undefined && n < control.minimum
            ? `at least ${control.minimum}`
            : control.maximum !== undefined && n > control.maximum
              ? `at most ${control.maximum}`
              : null;
    setProblem(why);
    if (why) return;
    setDraft(null);
    if (n !== value) onChange(n);
  };
  const range = [
    control.minimum !== undefined && `from ${control.minimum}`,
    control.maximum !== undefined && `to ${control.maximum}`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div>
      <input
        type="number"
        aria-label={label}
        disabled={disabled}
        min={control.minimum}
        max={control.maximum}
        value={shown}
        placeholder={control.nullable ? 'none' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(null);
            setProblem(null);
          }
        }}
        className={`${field} w-32 tabular-nums`}
      />
      {range && <span className="ml-2 text-xs text-faint">{range}</span>}
      {problem && <p className={ui.note(false)}>Must be {problem}.</p>}
    </div>
  );
}

function asList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function move<T>(list: T[], at: number, by: number): T[] {
  const next = [...list];
  [next[at], next[at + by]] = [next[at + by], next[at]];
  return next;
}

/** Up, down and remove buttons for a row of a list. */
function RowButtons({
  label,
  first,
  last,
  disabled,
  onMove,
  onRemove,
  onEdit,
}: {
  label: string;
  first: boolean;
  last: boolean;
  disabled?: boolean;
  onMove: (by: number) => void;
  onRemove?: () => void;
  onEdit?: () => void;
}) {
  return (
    <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 narrow:opacity-100">
      {onEdit && (
        <button type="button" className={iconBtn} disabled={disabled} aria-label={`Edit ${label}`} onClick={onEdit}>
          ✎
        </button>
      )}
      <button
        type="button"
        className={iconBtn}
        disabled={disabled || first}
        aria-label={`Move ${label} up`}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className={iconBtn}
        disabled={disabled || last}
        aria-label={`Move ${label} down`}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
      {onRemove && (
        <button type="button" className={iconBtn} disabled={disabled} aria-label={`Remove ${label}`} onClick={onRemove}>
          ✕
        </button>
      )}
    </span>
  );
}

const listBox = 'max-w-[520px] divide-y divide-rule-soft border border-rule bg-card';
const listRow = 'group flex min-h-8 items-center gap-2 px-2 py-0.5';

/** A list to add to, remove from and reorder: typed items, or items picked from the setting's choices. */
function ListField({
  control,
  value,
  onChange,
  label,
  disabled,
}: {
  control: Extract<Control, { kind: 'list' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
  disabled?: boolean;
}) {
  const list = asList(value);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ at: number; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const labelOf = (v: string) => control.choices?.find((c) => c.value === v)?.label ?? v;
  const left = control.choices?.filter((c) => !list.includes(c.value)) ?? [];
  const full = control.maxItems !== undefined && list.length >= control.maxItems;

  function check(text: string, except: number | null): string | null {
    if (!text) return 'Type something first.';
    if (control.maxLength !== undefined && text.length > control.maxLength)
      return `At most ${control.maxLength} characters.`;
    if (list.some((v, i) => v === text && i !== except)) return `“${text}” is in the list already.`;
    return null;
  }

  function add() {
    const text = adding.trim();
    const why = check(text, null);
    setProblem(why);
    if (why) return;
    onChange([...list, text]);
    setAdding('');
  }

  function saveEdit() {
    if (!editing) return;
    const text = editing.text.trim();
    const why = check(text, editing.at);
    setProblem(why);
    if (why) return;
    setEditing(null);
    if (text !== list[editing.at]) onChange(list.map((v, i) => (i === editing.at ? text : v)));
  }

  return (
    <div>
      <ul className={listBox} aria-label={label}>
        {list.length === 0 && <li className="px-2 py-1.5 text-faint italic">Nothing yet</li>}
        {list.map((v, i) => (
          <li key={v} className={listRow}>
            {editing?.at === i ? (
              <input
                autoFocus
                aria-label={`Edit ${labelOf(v)}`}
                className={`${field} my-0.5 flex-1`}
                value={editing.text}
                maxLength={control.maxLength}
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
              <span
                className="min-w-0 flex-1 break-words"
                onDoubleClick={() => !control.choices && !disabled && setEditing({ at: i, text: v })}
              >
                {labelOf(v)}
              </span>
            )}
            <RowButtons
              label={labelOf(v)}
              first={i === 0}
              last={i === list.length - 1}
              disabled={disabled}
              onMove={(by) => onChange(move(list, i, by))}
              onRemove={() => onChange(list.filter((x) => x !== v))}
              onEdit={control.choices ? undefined : () => setEditing({ at: i, text: v })}
            />
          </li>
        ))}
      </ul>
      {!full && (!control.choices || left.length > 0) && (
        <form
          className="mt-2 flex max-w-[520px] gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (control.choices) {
              if (adding) onChange([...list, adding]);
              setAdding('');
            } else add();
          }}
        >
          {control.choices ? (
            <select
              className={`${field} flex-1`}
              aria-label={`Add to ${label}`}
              disabled={disabled}
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">Choose one to add…</option>
              {left.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={`${field} flex-1`}
              aria-label={`Add to ${label}`}
              disabled={disabled}
              value={adding}
              maxLength={control.maxLength}
              placeholder={control.placeholder ?? 'Add an item'}
              onChange={(e) => {
                setAdding(e.target.value);
                setProblem(null);
              }}
            />
          )}
          <button
            type="submit"
            className={`${ui.btn({ ghost: true, inline: true, flush: true })} border border-rule px-3`}
            disabled={disabled || !adding.trim()}
          >
            Add item
          </button>
        </form>
      )}
      {full && <p className={`${ui.fine} mt-1`}>The list is full: at most {control.maxItems} items.</p>}
      {problem && <p className={ui.note(false)}>{problem}</p>}
    </div>
  );
}

/** A box per choice. Ids the setting names that aren't among the choices (a plugin not loaded here) are kept. */
function Checklist({
  control,
  value,
  onChange,
  disabled,
}: {
  control: Extract<Control, { kind: 'checklist' }>;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const list = asList(value);
  const known = new Set(control.choices.map((c) => c.value));
  const toggle = (v: string, ticked: boolean) => {
    const listed = control.inverted ? !ticked : ticked;
    const others = list.filter((x) => !known.has(x));
    const mine = control.choices.map((c) => c.value).filter((x) => (x === v ? listed : list.includes(x)));
    onChange([...others, ...mine]);
  };
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-6">
      {grouped(control.choices).map(([group, items]) => (
        <div key={group} className="mb-2">
          {group && <GroupLabel>{group}</GroupLabel>}
          {items.map((c) => (
            <label key={c.value} className="flex cursor-pointer items-center gap-2 py-0.5">
              <input
                type="checkbox"
                className="accent-accent"
                disabled={disabled}
                checked={control.inverted ? !list.includes(c.value) : list.includes(c.value)}
                onChange={(e) => toggle(c.value, e.target.checked)}
              />
              {c.label}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A fixed set of choices to put in order, within each group. The value lists those moved first, so choices added
 * later (a new panel) still take their usual place.
 */
function Rank({
  choices,
  value,
  onChange,
  disabled,
}: {
  choices: Choice[];
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const list = asList(value);
  const groups = useMemo(() => grouped(choices), [choices]);
  const ranked = (items: Choice[]) => {
    const rank = (v: string) =>
      list.includes(v) ? list.indexOf(v) : list.length + choices.findIndex((c) => c.value === v);
    return items.toSorted((a, b) => rank(a.value) - rank(b.value));
  };
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-6 gap-y-2">
      {groups.map(([group, items]) => {
        const order = ranked(items);
        return (
          <div key={group}>
            {group && <GroupLabel>{group}</GroupLabel>}
            <ol className={listBox}>
              {order.map((c, i) => (
                <li key={c.value} className={listRow}>
                  <span className="w-4 text-right text-xs text-faint tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1">{c.label}</span>
                  <RowButtons
                    label={c.label}
                    first={i === 0}
                    last={i === order.length - 1}
                    disabled={disabled}
                    onMove={(by) => {
                      const next = move(
                        order.map((x) => x.value),
                        i,
                        by,
                      );
                      // This group's whole new order, over what the setting says of the others.
                      onChange([...list.filter((v) => !next.includes(v)), ...next]);
                    }}
                  />
                </li>
              ))}
            </ol>
          </div>
        );
      })}
    </div>
  );
}
