import { describe, expect, it } from 'vitest';
import { WorkQueue } from '@/lib/work-queue';

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('WorkQueue', () => {
  it('runs a few at once, lines up a few more, and refuses the rest', async () => {
    const queue = new WorkQueue<number>(2, 1);
    const g = gate();
    let started = 0;
    const job = (n: number) => async () => {
      started += 1;
      await g.opened;
      return n;
    };
    const runs = [1, 2, 3, 4].map((n) => queue.run(String(n), job(n)));
    expect(runs[3]).toBeNull();
    await Promise.resolve();
    expect(started).toBe(2);
    g.open();
    expect(await Promise.all(runs.slice(0, 3))).toEqual([1, 2, 3]);
    expect(started).toBe(3);
    expect(await queue.run('5', job(5))).toBe(5);
  });

  it('shares one run between jobs under the same key', async () => {
    const queue = new WorkQueue<number>(1, 0);
    let runs = 0;
    const job = async () => ++runs;
    const [a, b] = [queue.run('k', job), queue.run('k', job)];
    expect(await a).toBe(1);
    expect(await b).toBe(1);
    expect(runs).toBe(1);
  });
});
