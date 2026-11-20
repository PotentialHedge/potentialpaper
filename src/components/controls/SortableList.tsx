'use client';

import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type ReactNode, useId } from 'react';
import { iconButtonClass } from './fields';

/**
 * A list to put in order: drag a row by its handle (dnd-kit), or with the keyboard (focus the handle, Space to pick
 * it up, the arrows to move it, Space to drop it), or with each row's up and down buttons. Generic over its items;
 * `actions` adds buttons of the caller's to each row (remove, edit), shown on hover; `trailing` adds a control of the
 * caller's at the end of each row, always shown (a switch); `below` adds content under a row that moves with it (its
 * sub-items).
 *
 * With `container`, it is one of several lists in a `DndContext` of the caller's, which handles drops (moving items
 * between lists, `RankedOptions`); the list itself is a drop target by that id, and `target` marks it as one the
 * dragged item may go to (`'can'`) or is over (`'over'`). The up and down buttons still call `onReorder`.
 */
export function SortableList<T>({
  items,
  getId,
  getLabel,
  onReorder,
  renderItem,
  actions,
  trailing,
  below,
  label,
  numbered = false,
  nested = false,
  disabled,
  empty = 'Nothing yet',
  container,
  target,
  overlay = false,
}: {
  items: T[];
  /** A stable, unique id per item. */
  getId: (item: T) => string;
  /** Its name in words, for the buttons' labels and what a screen reader hears while dragging. */
  getLabel: (item: T) => string;
  onReorder: (items: T[]) => void;
  renderItem?: (item: T, index: number) => ReactNode;
  actions?: (item: T, index: number) => ReactNode;
  trailing?: (item: T, index: number) => ReactNode;
  below?: (item: T, index: number) => ReactNode;
  /** Names the list for assistive tech. */
  label: string;
  /** Number the rows, for a ranking. */
  numbered?: boolean;
  /** Drawn inside another list's row, as its sub-items: no box of its own. */
  nested?: boolean;
  disabled?: boolean;
  empty?: ReactNode;
  container?: string;
  target?: 'can' | 'over';
  /** The dragged row is drawn by the caller's `DragOverlay`, so its own stays put, faded. */
  overlay?: boolean;
}) {
  const id = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map(getId);
  const byId = (itemId: string | number) => items.find((i) => getId(i) === itemId);
  const name = (itemId: string | number) => {
    const item = byId(itemId);
    return item ? getLabel(item) : String(itemId);
  };
  const position = (itemId: string | number | undefined) =>
    itemId === undefined ? 0 : ids.indexOf(String(itemId)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${name(active.id)}, at ${position(active.id)} of ${items.length}.`,
    onDragOver: ({ active, over }) =>
      over ? `${name(active.id)} is now at ${position(over.id)} of ${items.length}.` : undefined,
    onDragEnd: ({ active, over }) =>
      over ? `Dropped ${name(active.id)} at ${position(over.id)} of ${items.length}.` : `Dropped ${name(active.id)}.`,
    onDragCancel: ({ active }) => `Put ${name(active.id)} back where it was.`,
  };

  const rows = items.map((item, i) => (
    <SortableRow
      key={getId(item)}
      id={getId(item)}
      label={getLabel(item)}
      index={i}
      count={items.length}
      numbered={numbered}
      disabled={disabled}
      onMove={(by) => onReorder(arrayMove(items, i, i + by))}
      actions={actions?.(item, i)}
      trailing={trailing?.(item, i)}
      below={below?.(item, i)}
      ghost={overlay}
    >
      {renderItem ? renderItem(item, i) : getLabel(item)}
    </SortableRow>
  ));

  if (container)
    return (
      <ListBody
        container={container}
        target={target}
        ids={ids}
        label={label}
        nested={nested}
        disabled={disabled}
        empty={empty}
      >
        {rows}
      </ListBody>
    );

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id || !ids.includes(String(over.id))) return;
    onReorder(arrayMove(items, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  }

  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'To move it, press Space, then the up and down arrows, then Space again to drop it, or Escape to cancel.',
        },
      }}
      onDragEnd={onDragEnd}
    >
      <ListBody container={`${id}-list`} ids={ids} label={label} nested={nested} disabled={disabled} empty={empty}>
        {rows}
      </ListBody>
    </DndContext>
  );
}

/** A list's rows in their sortable context, and the list as a drop target (for a drop into another list, or an empty one). */
function ListBody({
  container,
  target,
  ids,
  label,
  nested,
  disabled,
  empty,
  children,
}: {
  container: string;
  target?: 'can' | 'over';
  ids: string[];
  label: string;
  nested: boolean;
  disabled?: boolean;
  empty: ReactNode;
  children: ReactNode[];
}) {
  const { setNodeRef } = useDroppable({ id: container, disabled });
  const ring = target === 'over' ? 'ring-2 ring-accent' : target === 'can' ? 'ring-1 ring-accent/40' : '';
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy} disabled={disabled}>
      <ol
        ref={setNodeRef}
        aria-label={label}
        className={`relative max-w-[520px] divide-y divide-rule-soft ${nested ? 'min-h-8 border-l border-rule-soft' : 'border border-rule bg-card'} ${ring}`}
      >
        {children.length === 0 && <li className="px-2 py-1.5 text-faint italic">{empty}</li>}
        {children}
      </ol>
    </SortableContext>
  );
}

function GripIcon() {
  return (
    <svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true" className="h-4 w-2.5">
      {[3, 8, 13].flatMap((y) => [
        <circle key={`a${y}`} cx="3" cy={y} r="1.2" />,
        <circle key={`b${y}`} cx="7" cy={y} r="1.2" />,
      ])}
    </svg>
  );
}

function SortableRow({
  id,
  label,
  index,
  count,
  numbered,
  disabled,
  onMove,
  actions,
  trailing,
  below,
  ghost,
  children,
}: {
  id: string;
  label: string;
  index: number;
  count: number;
  numbered: boolean;
  disabled?: boolean;
  onMove: (by: number) => void;
  actions?: ReactNode;
  trailing?: ReactNode;
  below?: ReactNode;
  /** While dragged, stay put, faded: the caller's `DragOverlay` follows the pointer instead. */
  ghost?: boolean;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`bg-card ${isDragging ? (ghost ? 'opacity-40' : 'relative z-10 shadow-md ring-1 ring-frame') : ''}`}
    >
      <div className="group flex min-h-8 items-center gap-1.5 py-0.5 pr-2 pl-0.5">
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Drag ${label}`}
          disabled={disabled}
          className={`${iconButtonClass} cursor-grab touch-none text-faint active:cursor-grabbing`}
        >
          <GripIcon />
        </button>
        {numbered && <span className="w-4 text-right text-xs text-faint tabular-nums">{index + 1}</span>}
        <span className="min-w-0 flex-1 break-words">{children}</span>
        <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 narrow:opacity-100">
          {actions}
          <button
            type="button"
            className={iconButtonClass}
            disabled={disabled || index === 0}
            aria-label={`Move ${label} up`}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={iconButtonClass}
            disabled={disabled || index === count - 1}
            aria-label={`Move ${label} down`}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </span>
        {trailing && <span className="ml-1 flex shrink-0 items-center">{trailing}</span>}
      </div>
      {below && <div className="pb-1 pl-7">{below}</div>}
    </li>
  );
}
