import type { Presentation } from './versions';

/**
 * A submission's presentations as the infobox words them (`lib/versions.ts` `Presentation`): the day and time as the
 * venue's clock says them, read off the stored local time, so the server and every reader's browser agree. Pure.
 */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-12-08T10:00:00+11:00` → its local date and `10:00`, as written. */
function parts(time: string): { y: number; m: number; d: number; hm: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(time);
  if (!match) return null;
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]), hm: match[4] };
}

/** "Tue 8 Dec, 10:00–13:00"; an end on another day names it: "Tue 8 Dec, 23:00 – Wed 9 Dec, 01:00". */
export function presentationWhen(p: Pick<Presentation, 'start' | 'end'>): string {
  const start = parts(p.start);
  if (!start) return p.start;
  const day = (x: { y: number; m: number; d: number }) =>
    `${DAYS[new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay()]} ${x.d} ${MONTHS[x.m - 1]}`;
  const end = p.end ? parts(p.end) : null;
  if (!end) return `${day(start)}, ${start.hm}`;
  if (end.y === start.y && end.m === start.m && end.d === start.d) return `${day(start)}, ${start.hm}–${end.hm}`;
  return `${day(start)}, ${start.hm} – ${day(end)}, ${end.hm}`;
}

/** "Hall 1 - 4, board #S2609", or what of it is known. */
export function presentationWhere(p: Pick<Presentation, 'room' | 'board'>): string | null {
  const board = p.board && `board ${p.board}`;
  return [p.room, board].filter(Boolean).join(', ') || null;
}

/** Soonest first. */
export function sortPresentations<T extends Pick<Presentation, 'start'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
