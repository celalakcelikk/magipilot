// Pool of pre-started, single-use processes (the warm pool; docs/plans/phase-1.md §4.3).
// Faz 0 showed a `claude -p --input-format stream-json` process waits for its first message
// indefinitely without calling the API, so start-up (~0.6 s) can be paid ahead of time.

export interface WarmPoolOptions<T> {
  /** Number of spare processes kept ready (≥ 1). */
  size: number;
  /** A spare is used only after it has existed this long (the bench uses 3000 for comparability). */
  minIdleMs?: number;
  /** Spares older than this are replaced (default 10 min), so no process lives for hours. */
  maxIdleMs?: number;
  spawn(): T;
  /** Stops an unused spare. */
  discard(item: T): Promise<void> | void;
  /** False when a spare died on its own; it is then dropped instead of handed out. */
  isAlive?(item: T): boolean;
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

interface Spare<T> {
  item: T;
  spawnedAt: number;
}

export class WarmPool<T> {
  private spares: Spare<T>[] = [];
  private disposed = false;

  constructor(private readonly options: WarmPoolOptions<T>) {
    if (options.size < 1) throw new Error('WarmPool size must be at least 1');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get spareCount(): number {
    return this.spares.length;
  }

  /** Starts spares until the pool is full. */
  prime(): void {
    while (!this.disposed && this.spares.length < this.options.size) {
      this.spares.push({ item: this.options.spawn(), spawnedAt: this.now() });
    }
  }

  private dropUnusable(): void {
    const maxIdle = this.options.maxIdleMs ?? 10 * 60_000;
    const keep: Spare<T>[] = [];
    for (const spare of this.spares) {
      const dead = this.options.isAlive ? !this.options.isAlive(spare.item) : false;
      if (dead || this.now() - spare.spawnedAt > maxIdle) {
        void this.options.discard(spare.item);
      } else {
        keep.push(spare);
      }
    }
    this.spares = keep;
  }

  /** Hands out a ready process and immediately starts its replacement. */
  async take(): Promise<T> {
    if (this.disposed) throw new Error('WarmPool is disposed');
    this.dropUnusable();
    this.prime();
    const spare = this.spares.shift()!;
    this.prime();
    const idle = this.now() - spare.spawnedAt;
    const minIdle = this.options.minIdleMs ?? 0;
    if (idle < minIdle) {
      await (this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(minIdle - idle);
    }
    return spare.item;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const spares = this.spares;
    this.spares = [];
    await Promise.all(spares.map(async (spare) => this.options.discard(spare.item)));
  }
}
