'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * Rendered HTML that changes as someone types, replacing only the top-level blocks that changed. Setting
 * the whole HTML again would rebuild every block: a demo's frame would load again from blank, at its
 * first height, and the page would flash and jump on every keystroke.
 */

/** The HTML each kept node was made from, since a frame's own attributes change once it runs. */
const sourceOf = new WeakMap<Node, string>();

const htmlOf = (node: Node) => (node instanceof Element ? node.outerHTML : (node.textContent ?? ''));

function patch(into: HTMLElement, html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const next = [...template.content.childNodes];
  for (const node of next) sourceOf.set(node, htmlOf(node));
  const old = [...into.childNodes];
  const same = (a: Node, b: Node) => sourceOf.get(a) === sourceOf.get(b);

  // The blocks before and after the one being typed in stay as they are.
  let start = 0;
  while (start < old.length && start < next.length && same(old[start], next[start])) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    same(old[old.length - 1 - end], next[next.length - 1 - end])
  )
    end++;

  const anchor = old[old.length - end] ?? null;
  for (const node of old.slice(start, old.length - end)) node.remove();
  for (const node of next.slice(start, next.length - end)) into.insertBefore(node, anchor);
}

export function PreviewHtml({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) patch(ref.current, html);
  }, [html]);
  return <div ref={ref} />;
}
