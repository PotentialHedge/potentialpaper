/**
 * Renders refreshed paper pages again straight away, in the background, so the next reader gets them from the cache.
 * `revalidatePath` only drops a page: whoever asks for it next waits for a whole render, seconds while an import
 * commits to a venue's papers, and an import commits to the most read papers (their reviews come in) the most.
 *
 * A page is asked for at its short address, from this process's own port, a moment after the refresh (Next applies a
 * route's invalidations once it has answered), one page at a time. Production only: in development and tests a page
 * is rendered on each visit anyway.
 */

const SHORT_PATH = /^\/s\/\d{1,12}$/;
const DELAY_MS = 2_000;

/** Paths to render, each with when: a refresh's paths wait out the delay even when others are being rendered. */
const waiting = new Map<string, number>();
let draining = false;

export function warmSoon(paths: Iterable<string>): void {
  if (process.env.NODE_ENV !== 'production') return;
  const due = Date.now() + DELAY_MS;
  for (const path of paths) if (SHORT_PATH.test(path)) waiting.set(path, due);
  if (waiting.size === 0 || draining) return;
  draining = true;
  void drain();
}

async function drain(): Promise<void> {
  const base = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  try {
    while (waiting.size > 0) {
      const [path, due] = waiting.entries().next().value!;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait).unref?.());
      // Refreshed again meanwhile: wait for that one.
      if (waiting.get(path) !== due) continue;
      waiting.delete(path);
      try {
        const res = await fetch(`${base}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
        await res.arrayBuffer();
      } catch (err) {
        console.error('warm', path, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    draining = false;
  }
}
