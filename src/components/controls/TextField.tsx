'use client';

import { useState } from 'react';
import { ui } from '@/components/ui';
import { fieldClass } from './fields';

/**
 * A text field that reports its value when you leave it or press Enter (Cmd/Ctrl+Enter in a box of several lines),
 * not on every key: for a setting saved as it changes. Escape puts the saved value back.
 */
export function CommitTextField({
  value,
  onCommit,
  label,
  multiline = false,
  maxLength,
  placeholder,
  disabled,
  className = '',
}: {
  value: string;
  onCommit: (value: string) => void;
  label: string;
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  const common = {
    'aria-label': label,
    disabled,
    value: shown,
    maxLength,
    placeholder,
    onBlur: commit,
  };
  return multiline ? (
    <textarea
      {...common}
      rows={Math.min(12, Math.max(3, shown.split('\n').length + 1))}
      className={`${fieldClass} block w-full max-w-[560px] ${className}`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  ) : (
    <input
      {...common}
      className={`${fieldClass} block w-full max-w-[420px] ${className}`}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/**
 * A number field that reports its value when you leave it or press Enter, and only one within its range. Empty is
 * `null` when `nullable`.
 */
export function CommitNumberField({
  value,
  onCommit,
  label,
  minimum,
  maximum,
  nullable = false,
  disabled,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
  label: string;
  minimum?: number;
  maximum?: number;
  nullable?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = draft ?? (value === null ? '' : String(value));
  const commit = () => {
    if (draft === null) return;
    const n = draft.trim() === '' ? null : Number(draft);
    const why =
      n === null
        ? nullable
          ? null
          : 'a number'
        : !Number.isFinite(n)
          ? 'a number'
          : minimum !== undefined && n < minimum
            ? `at least ${minimum}`
            : maximum !== undefined && n > maximum
              ? `at most ${maximum}`
              : null;
    setProblem(why);
    if (why) return;
    setDraft(null);
    if (n !== value) onCommit(n);
  };
  const range = [minimum !== undefined && `from ${minimum}`, maximum !== undefined && `to ${maximum}`]
    .filter(Boolean)
    .join(' ');
  return (
    <div>
      <input
        type="number"
        aria-label={label}
        aria-invalid={problem !== null}
        disabled={disabled}
        min={minimum}
        max={maximum}
        value={shown}
        placeholder={nullable ? 'none' : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') {
            setDraft(null);
            setProblem(null);
          }
        }}
        className={`${fieldClass} w-32 tabular-nums`}
      />
      {range && <span className="ml-2 text-xs text-faint">{range}</span>}
      {problem && <p className={ui.note(false)}>Must be {problem}.</p>}
    </div>
  );
}
