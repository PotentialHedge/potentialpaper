import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttlCache } from '@/server/ttl-cache';

describe('ttlCache', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads again once an answer is older than its time', async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1000);
    let n = 0;
    const load = async () => ++n;
    expect(await cache('k', load)).toBe(1);
    expect(await cache('k', load)).toBe(1);
    vi.advanceTimersByTime(1001);
    expect(await cache('k', load)).toBe(2);
  });

  it('gives a stale answer at once and loads a fresh one behind it', async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1000, 10, { staleMs: 5000 });
    let n = 0;
    const load = vi.fn(async () => ++n);
    expect(await cache('k', load)).toBe(1);
    vi.advanceTimersByTime(2000);
    // Stale: the old answer, and one refresh however many ask meanwhile.
    const [a, b] = [cache('k', load), cache('k', load)];
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await cache('k', load)).toBe(2);
    // Past the stale window, a reader waits for a fresh one.
    vi.advanceTimersByTime(6000);
    expect(await cache('k', load)).toBe(3);
  });

  it('keeps the stale answer when its refresh fails, and tries again', async () => {
    vi.useFakeTimers();
    const cache = ttlCache<number>(1000, 10, { staleMs: 5000 });
    expect(await cache('k', async () => 1)).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(await cache('k', () => Promise.reject(new Error('down')))).toBe(1);
    const retried = cache('k', async () => 2);
    expect(await retried).toBe(1);
    expect(await cache('k', async () => 3)).toBe(2);
  });
});
