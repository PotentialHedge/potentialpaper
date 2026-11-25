/**
 * Answers kept in this process for `ttlMs`, by key, at most `max` of them (the oldest dropped first). A pending answer
 * is shared, so readers arriving together run the query once; a failed one is forgotten.
 */
const all = new Set<Map<string, unknown>>();

export function ttlCache<T>(ttlMs: number, max = 1000) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  all.add(entries);
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const now = Date.now();
    const hit = entries.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;
    entries.delete(key);
    const value = load();
    entries.set(key, { at: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    if (entries.size > max) entries.delete(entries.keys().next().value!);
    return value;
  };
}

/** Forgets every kept answer: for tests, which empty the database between cases. */
export function clearTtlCaches(): void {
  for (const entries of all) entries.clear();
}
