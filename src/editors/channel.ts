import type { PageRef } from '@/lib/kinds';

/**
 * The messages between an editor's frame and its host page, over a `BroadcastChannel` (same-origin, so the
 * editor may post from a worker, as a VS Code extension runs in one). Part of the editor contract (`types.ts`).
 */
export function editorChannelName({ scheme, value }: PageRef): string {
  return `potentialpaper-editor:${scheme}:${value}`;
}

/** From the editor. */
export type EditorMessage =
  /** The editor has loaded the page; `previews` if it shows sections as the page does itself (webviews on). */
  | { type: 'ready'; previews?: boolean }
  /** The file in front, and its text as typed (saved or not), or `null` for none of the page's files. */
  | { type: 'active'; path: string | null; text: string | null }
  /** A commit went in. */
  | { type: 'committed'; head: string | null };

/** From the host page. */
export type HostMessage =
  /** The host page has (re)loaded: send `ready` and `active` again. */
  | { type: 'hello' }
  /** Open this file. */
  | { type: 'open'; path: string };
