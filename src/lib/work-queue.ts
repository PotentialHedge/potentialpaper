/**
 * At most `running` jobs at once, at most `waiting` more in line behind them; past that `run` refuses (`null`) rather
 * than let work pile up. Jobs under the same key share one run.
 */
export class WorkQueue<T> {
  private active = 0;
  private readonly line: (() => void)[] = [];
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly running: number,
    private readonly waiting: number,
  ) {}

  run(key: string, job: () => Promise<T>): Promise<T> | null {
    const shared = this.pending.get(key);
    if (shared) return shared;
    if (this.active >= this.running && this.line.length >= this.waiting) return null;
    const result = this.inTurn(job).finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }

  private async inTurn(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.running) await new Promise<void>((go) => this.line.push(go));
    this.active += 1;
    try {
      return await job();
    } finally {
      this.active -= 1;
      this.line.shift()?.();
    }
  }
}
