'use client';

import { byGroup, type GroupedOption, GroupLabel } from './CheckboxGroup';
import { SortableList } from './SortableList';

/**
 * A fixed set of options to put in order, each group its own list to drag within. The value lists those moved first,
 * in their order, so an option added later (a new panel) still takes its usual place after them.
 */
export function RankedOptions({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: GroupedOption[];
  value: string[];
  onChange: (value: string[]) => void;
  label: string;
  disabled?: boolean;
}) {
  const rank = (v: string) =>
    value.includes(v) ? value.indexOf(v) : value.length + options.findIndex((o) => o.value === v);
  const text = (o: GroupedOption) => (typeof o.label === 'string' ? o.label : o.value);
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-6 gap-y-2">
      {byGroup(options).map(([group, items]) => (
        <div key={group}>
          {group && <GroupLabel>{group}</GroupLabel>}
          <SortableList
            items={items.toSorted((a, b) => rank(a.value) - rank(b.value))}
            getId={(o) => o.value}
            getLabel={text}
            renderItem={(o) => o.label}
            numbered
            disabled={disabled}
            label={group ? `${label}: ${group}` : label}
            onReorder={(next) => {
              const order = next.map((o) => o.value);
              // This group's whole new order, over what the value says of the others.
              onChange([...value.filter((v) => !order.includes(v)), ...order]);
            }}
          />
        </div>
      ))}
    </div>
  );
}
