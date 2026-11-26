/** How long ago a moment was, as a reader says it: "just now", "3 hours ago". Pure, for the server and the browser. */
export function ago(iso: string | Date, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const [n, unit] =
    s < 3600
      ? [s / 60, 'minute']
      : s < 86_400
        ? [s / 3600, 'hour']
        : s < 30 * 86_400
          ? [s / 86_400, 'day']
          : s < 365 * 86_400
            ? [s / (30 * 86_400), 'month']
            : [s / (365 * 86_400), 'year'];
  const k = Math.floor(n);
  return `${k} ${unit}${k === 1 ? '' : 's'} ago`;
}
