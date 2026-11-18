'use client';

import { byGroup, type GroupedOption, GroupLabel } from './CheckboxGroup';
import { SortableList } from './SortableList';
import { Switch } from './Switch';

/**
 * A fixed set of options to put in order, each group its own list to drag within. The value lists those moved first,
 * in their order, so an option added later (a new panel) still takes its usual place after them.
 *
 * With `hidden` and `onHiddenChange`, each row also has a switch: on shows it, off lists it in `hidden` and greys it.
 * Values `hidden` names that aren't among the options (a plugin not loaded here) are kept.
 *
 * An option with a `parent` among the options is drawn under it, in a list of its own to drag within, and greyed
 * while its parent is hidden (a plugin's panel under each submission, under "Submissions and reviews").
 */
export function RankedOptions({
  options,
  value,
  onChange,
  hidden,
  onHiddenChange,
  label,
  disabled,
}: {
  options: GroupedOption[];
  value: string[];
  onChange: (value: string[]) => void;
  hidden?: string[];
  onHiddenChange?: (hidden: string[]) => void;
  label: string;
  disabled?: boolean;
}) {
  const rank = (v: string) =>
    value.includes(v) ? value.indexOf(v) : value.length + options.findIndex((o) => o.value === v);
  const text = (o: GroupedOption) => (typeof o.label === 'string' ? o.label : o.value);
  const toggles = hidden !== undefined && onHiddenChange !== undefined;
  const isHidden = (v: string) => hidden?.includes(v) ?? false;
  const setShown = (v: string, shown: boolean) => {
    if (!onHiddenChange || !hidden) return;
    const known = new Set(options.map((o) => o.value));
    const others = hidden.filter((x) => !known.has(x));
    const mine = options.map((o) => o.value).filter((x) => (x === v ? !shown : hidden.includes(x)));
    onHiddenChange([...others, ...mine]);
  };
  const known = new Set(options.map((o) => o.value));
  /** An option's sub-items: those naming it as their parent. */
  const childrenOf = (v: string) => options.filter((o) => o.parent === v);

  /** One list: the options given, ranked, each with its sub-items in a list of their own under it. */
  const list = (items: GroupedOption[], name: string, nested = false, inHidden = false) => (
    <SortableList
      items={items.toSorted((a, b) => rank(a.value) - rank(b.value))}
      getId={(o) => o.value}
      getLabel={text}
      renderItem={(o) => (
        <span
          className={toggles && (inHidden || isHidden(o.value)) ? 'text-faint line-through decoration-rule-strong' : ''}
        >
          {o.label}
        </span>
      )}
      trailing={
        toggles
          ? (o) =>
              o.locked ? (
                <span className="w-8 shrink-0" aria-hidden />
              ) : (
                <Switch
                  checked={!isHidden(o.value)}
                  onCheckedChange={(on) => setShown(o.value, on)}
                  aria-label={`Show ${text(o)}`}
                  disabled={disabled}
                />
              )
          : undefined
      }
      below={(o) => {
        const sub = childrenOf(o.value);
        return sub.length ? list(sub, `${name}: ${text(o)}`, true, inHidden || isHidden(o.value)) : null;
      }}
      numbered
      nested={nested}
      disabled={disabled}
      label={name}
      onReorder={(next) => {
        const order = next.map((o) => o.value);
        // This list's whole new order, over what the value says of the others.
        onChange([...value.filter((v) => !order.includes(v)), ...order]);
      }}
    />
  );

  // Sub-items are drawn under their parent, when it is among the options; otherwise in their own group.
  const top = options.filter((o) => !o.parent || !known.has(o.parent));
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-6 gap-y-2">
      {byGroup(top).map(([group, items]) => (
        <div key={group}>
          {group && <GroupLabel>{group}</GroupLabel>}
          {list(items, group ? `${label}: ${group}` : label)}
        </div>
      ))}
    </div>
  );
}
