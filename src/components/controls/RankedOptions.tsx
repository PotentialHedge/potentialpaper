'use client';

import {
  type CollisionDetection,
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { type ReactNode, useId, useState } from 'react';
import { byGroup, type GroupedOption, GroupLabel, type OptionPlace } from './CheckboxGroup';
import { SortableList } from './SortableList';
import { Switch } from './Switch';

const LIST = 'list:';

/**
 * Of the drop targets under the pointer, the smallest: a row inside a nested list rather than the row holding that
 * list. Never the dragged row itself.
 */
const innermost: CollisionDetection = (args) => {
  const hits = pointerWithin(args).filter((c) => c.id !== args.active.id);
  const area = (id: string | number) => {
    const r = args.droppableRects.get(id);
    return r ? r.width * r.height : Infinity;
  };
  return hits.toSorted((a, b) => area(a.id) - area(b.id)).slice(0, 1);
};

/**
 * A fixed set of options to put in order, each group its own list to drag within. The value lists those moved first,
 * in their order, so an option added later (a new panel) still takes its usual place after them.
 *
 * With `hidden` and `onHiddenChange`, each row also has a switch: on shows it, off lists it in `hidden` and greys it.
 * Values `hidden` names that aren't among the options (a plugin not loaded here) are kept.
 *
 * An option with a `parent` among the options is drawn under it, in a list of its own to drag within, and greyed
 * while its parent is hidden (a plugin's panel under each submission, under "Submissions and reviews").
 *
 * With `menuAfter`, every shown option past that many, in order, is marked as in the menu (the page actions' bar shows
 * that many, and the rest in its "⋯" menu).
 *
 * With `placement` and `onMove`, an option with `places` is drawn in the list (group, and parent) of the place
 * `placement` names, or else of its first, and is dragged into any other of its places' lists to move it there; the
 * lists it may go to are outlined while it is dragged, and empty ones shown. `onMove` gets the new order and placement
 * together, to save as one change.
 */
export function RankedOptions({
  options,
  value,
  onChange,
  hidden,
  onHiddenChange,
  placement,
  onMove,
  menuAfter,
  label,
  disabled,
}: {
  options: GroupedOption[];
  value: string[];
  onChange: (value: string[]) => void;
  hidden?: string[];
  onHiddenChange?: (hidden: string[]) => void;
  placement?: Record<string, string>;
  onMove?: (value: string[], placement: Record<string, string>) => void;
  menuAfter?: number;
  label: string;
  disabled?: boolean;
}) {
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [dragging, setDragging] = useState<string | null>(null);
  const [overList, setOverList] = useState<string | null>(null);

  const movable = placement !== undefined && onMove !== undefined;
  const known = new Set(options.map((o) => o.value));
  /** Where an option is: the place `placement` names, or its first. */
  const placeOf = (o: GroupedOption) => o.places?.find((p) => p.value === placement?.[o.value]) ?? o.places?.[0];
  if (movable) {
    options = options.map((o) => {
      const place = placeOf(o);
      return place ? { ...o, group: place.group, parent: place.parent } : o;
    });
  }
  /** The list a place, or an option, is drawn in: under its parent when that is among the options, else its group's. */
  const listOf = (where: { group?: string; parent?: string }) =>
    where.parent && known.has(where.parent) ? `>${where.parent}` : `#${where.group ?? ''}`;

  const rank = (v: string) =>
    value.includes(v) ? value.indexOf(v) : value.length + options.findIndex((o) => o.value === v);
  const ranked = (list: GroupedOption[]) => list.toSorted((a, b) => rank(a.value) - rank(b.value));
  const text = (o: GroupedOption) => (typeof o.label === 'string' ? o.label : o.value);
  const toggles = hidden !== undefined && onHiddenChange !== undefined;
  const isHidden = (v: string) => hidden?.includes(v) ?? false;
  const setShown = (v: string, shown: boolean) => {
    if (!onHiddenChange || !hidden) return;
    const others = hidden.filter((x) => !known.has(x));
    const mine = options.map((o) => o.value).filter((x) => (x === v ? !shown : hidden.includes(x)));
    onHiddenChange([...others, ...mine]);
  };
  /** The shown options past `menuAfter`, in order: those in the menu. */
  const inMenu = new Set(
    menuAfter === undefined
      ? []
      : ranked(options)
          .filter((o) => !isHidden(o.value))
          .slice(menuAfter)
          .map((o) => o.value),
  );
  /** A list's whole new order, over what the value says of the others. */
  const withOrder = (order: string[]) => [...value.filter((v) => !order.includes(v)), ...order];

  const active = dragging ? options.find((o) => o.value === dragging) : undefined;
  /** The lists the dragged option may be dropped in, by place. */
  const targets = new Map<string, OptionPlace>(
    movable && active?.places && active.places.length > 1 ? active.places.map((p) => [listOf(p), p]) : [],
  );
  const targetOf = (list: string): 'can' | 'over' | undefined =>
    !targets.has(list) || list === listOf(active!) ? undefined : list === overList ? 'over' : 'can';

  const listOfDrop = (overId: string) =>
    overId.startsWith(LIST)
      ? overId.slice(LIST.length)
      : (() => {
          const o = options.find((x) => x.value === overId);
          return o ? listOf(o) : null;
        })();

  function onDragEnd({ active: a, over }: DragEndEvent) {
    setDragging(null);
    setOverList(null);
    if (!over || !onMove) return;
    const moved = options.find((o) => o.value === a.id);
    if (!moved) return;
    const overId = String(over.id);
    const from = listOf(moved);
    const to = listOfDrop(overId);
    if (!to) return;
    const items = ranked(options.filter((o) => listOf(o) === to)).map((o) => o.value);
    if (to === from) {
      if (overId === moved.value || !items.includes(overId)) return;
      onChange(withOrder(arrayMove(items, items.indexOf(moved.value), items.indexOf(overId))));
      return;
    }
    const place = targets.get(to);
    if (!place) return;
    // Into the other list, where it was dropped: before the row it is over, after it if dropped on its lower half, or
    // at the end of the list.
    const at = items.indexOf(overId);
    const dragged = a.rect.current.translated;
    const below = dragged !== null && dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2;
    items.splice(at < 0 ? items.length : at + (below ? 1 : 0), 0, moved.value);
    const { [moved.value]: _old, ...rest } = placement ?? {};
    void _old;
    // The first place is where it goes anyway, so it isn't written.
    onMove(withOrder(items), place.value === moved.places?.[0]?.value ? rest : { ...rest, [moved.value]: place.value });
  }

  /** One list: the options given, ranked, each with its sub-items in a list of their own under it. */
  const list = (items: GroupedOption[], name: string, key: string, nested = false, inHidden = false): ReactNode => (
    <SortableList
      items={ranked(items)}
      getId={(o) => o.value}
      getLabel={text}
      renderItem={(o) => (
        <span
          className={toggles && (inHidden || isHidden(o.value)) ? 'text-faint line-through decoration-rule-strong' : ''}
        >
          {o.label}
          {inMenu.has(o.value) && <span className="ml-2 font-sans text-xs text-faint">in ⋯ menu</span>}
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
        const sub = options.filter((x) => x.parent === o.value);
        const subKey = `>${o.value}`;
        // An empty list under it only while something that may go there is dragged.
        if (!sub.length && !targets.has(subKey)) return null;
        return list(sub, `${name}: ${text(o)}`, subKey, true, inHidden || isHidden(o.value));
      }}
      numbered
      nested={nested}
      disabled={disabled}
      label={name}
      empty={movable ? 'Drag a plugin’s panel here' : undefined}
      onReorder={(next) => onChange(withOrder(next.map((o) => o.value)))}
      {...(movable && { container: `${LIST}${key}`, target: targetOf(key), overlay: targets.size > 0 })}
    />
  );

  // Sub-items are drawn under their parent, when it is among the options; otherwise in their own group.
  const top = options.filter((o) => !o.parent || !known.has(o.parent));
  const groups = byGroup(top);
  // Every top-level place a panel may be moved to has its list, empty or not, to drop it in.
  if (movable) {
    for (const o of options)
      for (const p of o.places ?? [])
        if (listOf(p).startsWith('#') && !groups.some(([g]) => g === (p.group ?? ''))) groups.push([p.group ?? '', []]);
  }
  const grid = (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-6 gap-y-2">
      {groups.map(([group, items]) => (
        <div key={group}>
          {group && <GroupLabel>{group}</GroupLabel>}
          {list(items, group ? `${label}: ${group}` : label, `#${group}`)}
        </div>
      ))}
    </div>
  );
  if (!movable) return grid;

  const draggingMovable = targets.size > 0;
  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={innermost}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      // A built-in panel stays in its list; a plugin's moves about the page.
      modifiers={draggingMovable ? [] : [restrictToVerticalAxis, restrictToParentElement]}
      onDragStart={({ active: a }: DragStartEvent) => setDragging(String(a.id))}
      onDragOver={({ over }: DragOverEvent) => setOverList(over ? listOfDrop(String(over.id)) : null)}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(null);
        setOverList(null);
      }}
    >
      {grid}
      <DragOverlay dropAnimation={null}>
        {active && targets.size > 0 && (
          <div className="flex min-h-8 cursor-grabbing items-center border border-frame bg-card px-3 py-0.5 shadow-md">
            {active.label}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
