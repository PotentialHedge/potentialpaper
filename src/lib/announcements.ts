/**
 * Which announcements this browser has dismissed, in a cookie, so the home page (rendered per request) leaves them
 * out rather than the browser hiding them after it draws. Space-separated ids, only the most recent few.
 */
export const DISMISSED_COOKIE = 'announcements_dismissed';

const KEEP = 20;
const UUID = /^[0-9a-f-]{36}$/;

export function parseDismissed(value: string | undefined): string[] {
  // Split on an encoded space too, in case a reader hands the cookie over undecoded.
  return (value ?? '').split(/ |%20/).filter((id) => UUID.test(id));
}

/** The cookie's value with `id` added, newest last. */
export function withDismissed(value: string | undefined, id: string): string {
  return [...parseDismissed(value).filter((d) => d !== id), id].slice(-KEEP).join(' ');
}
