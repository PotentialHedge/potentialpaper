'use client';

import {
  type ComponentProps,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { SearchExample } from '@/lib/search-examples';
import { track } from '@/lib/track';

/** How long each example stays in the placeholder. */
const ROTATE_MS = 5000;

/** Where this page load starts among the examples: drawn once in the browser, none on the server. */
const START = Math.random();
const noSubscribe = () => () => {};

/**
 * A search box that submits its form when its clear button (the browser's ×) empties it, so the
 * results follow. Typing or deleting down to nothing does not: only a clear, which the browser
 * sends as an input event without an `inputType`.
 *
 * `examples`: searches shown in turn in the placeholder ("Search for a paper, e.g. …", `lib/search-examples.ts`),
 * starting from one at random, moving on every few seconds while the box is empty and not focused. Tab or → in the
 * empty box fills in the one shown; the next Tab moves on as usual. Each shown and each used is counted.
 */
export function SearchInput({
  examples,
  placeholder,
  ...props
}: Omit<ComponentProps<'input'>, 'type' | 'onInput'> & { examples?: readonly SearchExample[] }) {
  // Picked in the browser: the page is the same HTML for every reader, so the server shows no example.
  const start = useSyncExternalStore(
    noSubscribe,
    () => START,
    () => null,
  );
  const [steps, setSteps] = useState(0);
  const [focused, setFocused] = useState(false);
  const [empty, setEmpty] = useState(!props.defaultValue);
  const shown = useRef(new Set<string>());
  const count = examples?.length ?? 0;

  useEffect(() => {
    if (start === null || count < 2 || focused || !empty) return;
    const timer = setTimeout(() => setSteps((n) => n + 1), ROTATE_MS);
    return () => clearTimeout(timer);
  }, [start, steps, count, focused, empty]);

  const example = start === null || !examples?.length ? null : examples[(Math.floor(start * count) + steps) % count];
  // Counted once a page view each, and only while it can be seen in the box.
  useEffect(() => {
    if (!example || !empty || shown.current.has(example.id)) return;
    shown.current.add(example.id);
    track('search_example_shown', { example: example.id });
  }, [example, empty]);

  function onInput(e: FormEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const native = e.nativeEvent as Partial<InputEvent>;
    setEmpty(input.value === '');
    if (input.value === '' && !native.inputType) input.form?.requestSubmit();
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    props.onKeyDown?.(e);
    const input = e.currentTarget;
    const accept = (e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowRight';
    if (!example || !accept || input.value !== '' || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    input.value = example.q;
    input.setSelectionRange(example.q.length, example.q.length);
    setEmpty(false);
    track('search_example_used', { example: example.id });
  }
  return (
    <input
      {...props}
      type="search"
      placeholder={example ? `${placeholder ?? 'Search'}, e.g. ${example.q}` : placeholder}
      title={example && empty ? 'Tab fills in the example' : props.title}
      onInput={onInput}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}
