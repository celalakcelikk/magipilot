// The cache behind the chat content net's index (docs/plans/phase-2-hardening.md §3).

/** A file change during a build starts a new one, at most this many times per `get()`. */
export const MAX_REBUILDS_AFTER_CHANGE = 3;

/**
 * The latest result of an expensive build, kept for `ttlMs`. Concurrent callers share a build.
 * - `invalidate()` (settings or workspace folders changed): every caller, also one already
 *   waiting, gets a build that started after it; an older build is never returned (inspection
 *   HARD-I004), and neither is its failure (HARD-I008).
 * - `drop()` (a matching file changed): the same, so a line saved during a build is indexed
 *   before a waiting request is sent (HARD-I011). A file that keeps changing could restart the
 *   build forever, so after MAX_REBUILDS_AFTER_CHANGE new builds a caller takes the last result:
 *   built with the current settings, but possibly without the latest change.
 */
export class IndexCache<T> {
  /** Bumped by invalidate(): builds of an older generation are never returned. */
  private generation = 0;
  /** Bumped by invalidate() and drop(): a build of an older epoch may miss a change. */
  private epoch = 0;
  private cached?: { at: number; epoch: number; value: T };
  private building?: { generation: number; epoch: number; promise: Promise<T> };

  constructor(
    private readonly build: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<T> {
    let rebuilds = 0;
    for (;;) {
      const cached = this.cached;
      if (cached?.epoch === this.epoch && this.now() - cached.at < this.ttlMs) return cached.value;
      if (this.building?.epoch !== this.epoch) this.start();
      const building = this.building!;
      let result: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        result = { ok: true, value: await building.promise };
      } catch (error) {
        result = { ok: false, error };
      }
      if (building.epoch === this.epoch) {
        if (result.ok) return result.value;
        throw result.error;
      }
      // Settings or folders changed while it ran: never its result, nor its failure.
      if (building.generation !== this.generation) continue;
      // A file changed while it ran: build again, a bounded number of times.
      if (++rebuilds <= MAX_REBUILDS_AFTER_CHANGE) continue;
      if (result.ok) return result.value;
      throw result.error;
    }
  }

  invalidate(): void {
    this.generation++;
    this.epoch++;
    this.cached = undefined;
  }

  drop(): void {
    this.epoch++;
    this.cached = undefined;
  }

  private start(): void {
    const entry = { generation: this.generation, epoch: this.epoch, promise: this.build() };
    this.building = entry;
    const done = (): void => {
      // A newer build may have replaced this one; never clear its reference.
      if (this.building === entry) this.building = undefined;
    };
    entry.promise.then((value) => {
      done();
      if (entry.epoch === this.epoch) this.cached = { at: this.now(), epoch: entry.epoch, value };
    }, done);
  }
}

/**
 * Runs `read` until `generation()` (bumped when the exclusion settings or the workspace folders
 * change) is the same before and after it, at most `attempts` times. A request reads the index
 * and then resolves names asynchronously, and both must belong to the same settings
 * (FOLLOWUP-I003). `stable` is false when the settings kept changing.
 */
export async function readStable<T>(
  generation: () => number,
  read: () => Promise<T>,
  attempts = 3,
): Promise<{ value: T; stable: boolean }> {
  for (let n = 1; ; n++) {
    const before = generation();
    const value = await read();
    if (generation() === before) return { value, stable: true };
    if (n >= attempts) return { value, stable: false };
  }
}
