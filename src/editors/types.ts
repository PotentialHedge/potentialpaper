import type { PageRef } from '@/lib/kinds';

/**
 * A web editor the site embeds for a page repo. The site gives it two things and nothing else, so that one
 * editor can be swapped for another (`docs/web-editor.md`):
 *
 * - the **workspace API** (`/api/v1/workspace…`, `src/server/workspace.ts`): the files at the head, a blob,
 *   a commit of several files, a rebase after a conflict, and an upload for a PDF or picture;
 * - a frame on the host page (`/code/<page>`), with a **channel** to it (`./channel.ts`) for the preview.
 *
 * An editor is a page served at `frameSrc`, framed by the host page and same-origin with it.
 */
export interface WebEditor {
  /** Short and stable: its files are under `public/editor/<id>/`. */
  id: string;
  /** What the host page calls it. */
  name: string;
  /** The page to frame for a page, of any kind. */
  frameSrc(page: PageRef): string;
}
