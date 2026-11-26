/**
 * Answers kept in this process for `ttlMs`, by key, at most `max` of them (the oldest dropped first). A pending answer
 * is shared, so readers arriving together run the query once; a failed one is forgotten.
 *
 * With `staleMs`, an answer older than `ttlMs` but younger than `staleMs` is still given at once, and a fresh one is
 * loaded behind it for the next reader: a list most readers see is then never waited for after its first load. A
 * failed refresh keeps the old answer.
 */
const all = new Set<Map<string, unknown>>();

export function ttlCache<T>(ttlMs: number, max = 1000, { staleMs = 0 }: { staleMs?: number } = {}) {
  const entries = new Map<string, { at: number; value: Promise<T>; refreshing?: boolean }>();
  all.add(entries);
  const store = (key: string, at: number, value: Promise<T>) => {
    entries.delete(key);
    entries.set(key, { at, value });
    if (entries.size > max) entries.delete(entries.keys().next().value!);
  };
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    if (hit && now - hit.at < staleMs) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        const next = load();
        next.then(
          () => {
            if (entries.get(key) === hit) store(key, Date.now(), next);
          },
          () => {
            if (entries.get(key) === hit) hit.refreshing = false;
          },
        );
      }
      return hit.value;
    }
    const value = load();
    store(key, now, value);
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    return value;
  };
}

/** Forgets every kept answer: for tests, which empty the database between cases. */
export function clearTtlCaches(): void {
  for (const entries of all) entries.clear();
}
