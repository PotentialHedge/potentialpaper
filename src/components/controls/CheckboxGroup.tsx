'use client';

import type { ReactNode } from 'react';
import { CheckboxField } from './Checkbox';

export interface GroupedOption {
  value: string;
  label: ReactNode;
  /** A heading the control sets it under. */
  group?: string;
  /** In a list with a switch per option, one that can't be switched off. */
  locked?: boolean;
}

/** Options by their `group`, in the order each group first appears. */
export function byGroup<O extends { group?: string }>(options: O[]): [string, O[]][] {
  const out = new Map<string, O[]>();
  for (const o of options) out.set(o.group ?? '', [...(out.get(o.group ?? '') ?? []), o]);
  return [...out];
}

/** A small heading over a group of options. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <div className="mt-2 mb-1 text-xs tracking-wide text-faint uppercase first:mt-0">{children}</div>;
}

/**
 * A box per option, in columns, under their groups' headings. The value lists the ticked ones, or with `inverted` the
 * unticked ones (a list of panels to hide, drawn as the panels shown). Values it doesn't offer are kept as they are,
 * in front.
 */
export function CheckboxGroup({
  options,
  value,
  onChange,
  inverted = false,
  disabled,
}: {
  options: GroupedOption[];
  value: string[];
  onChange: (value: string[]) => void;
  inverted?: boolean;
  disabled?: boolean;
}) {
  const known = new Set(options.map((o) => o.value));
  const toggle = (v: string, ticked: boolean) => {
    const listed = inverted ? !ticked : ticked;
    const others = value.filter((x) => !known.has(x));
    const mine = options.map((o) => o.value).filter((x) => (x === v ? listed : value.includes(x)));
    onChange([...others, ...mine]);
  };
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-x-6">
      {byGroup(options).map(([group, items]) => (
        <div key={group} className="mb-2">
          {group && <GroupLabel>{group}</GroupLabel>}
          {items.map((o) => (
            <CheckboxField
              key={o.value}
              label={o.label}
              disabled={disabled}
              checked={inverted ? !value.includes(o.value) : value.includes(o.value)}
              onCheckedChange={(c) => toggle(o.value, c)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
