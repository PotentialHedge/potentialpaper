/**
 * Example searches the home page's box offers as its placeholder ("Search for a paper, e.g. …"), as acceptodds does:
 * one at random, the next every few seconds while the box is empty and not being typed in; Tab or → in the empty box
 * fills in the one shown. Each shows a different part of the syntax (`lib/query.ts`) and finds a few dozen to a few
 * thousand papers quickly. The id is what Umami counts (`lib/track.ts`: `search_example_shown`, `_used`, and
 * `search_shown`'s `example`): give a changed query a new id, so its numbers start afresh.
 */
export const SEARCH_EXAMPLES = [
  { id: 'p1', q: 'diffusion venue:iclr year>=2026' },
  { id: 'p2', q: '"reward hacking" OR "specification gaming"' },
  { id: 'p3', q: 'title:benchmark -llm' },
  { id: 'p4', q: '"mixture of experts" venue:neurips' },
  { id: 'p5', q: '(venue:iclr OR venue:neurips) "in-context learning"' },
  { id: 'p6', q: 'title:"world model" year>=2026' },
] as const;

export type SearchExample = (typeof SEARCH_EXAMPLES)[number];

/** The example a query is, if it is one exactly (spacing aside). */
export function exampleOf(q: string | null | undefined): SearchExample | null {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
  if (!q) return null;
  return SEARCH_EXAMPLES.find((e) => norm(e.q) === norm(q)) ?? null;
}
