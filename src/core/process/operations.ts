// Active operations of one backend, so dispose() can abort them (inspection P1-I003). Each
// operation gets its own signal that aborts when the caller's signal aborts or the owner disposes.

export interface Operation {
  signal: AbortSignal;
  abort(): void;
  /** Must be called once the operation finished, successfully or not. */
  end(): void;
}

export class Operations {
  private readonly active = new Set<AbortController>();
  private closed = false;

  constructor(private readonly ownerName: string) {}

  get size(): number {
    return this.active.size;
  }

  get disposed(): boolean {
    return this.closed;
  }

  /** Throws once the owner was disposed: a disposed backend starts nothing new. */
  begin(outer?: AbortSignal): Operation {
    if (this.closed) throw new Error(`${this.ownerName} was disposed`);
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener('abort', forward, { once: true });
    this.active.add(controller);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      end: () => {
        this.active.delete(controller);
        outer?.removeEventListener('abort', forward);
      },
    };
  }

  async run<T>(
    outer: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const operation = this.begin(outer);
    try {
      return await fn(operation.signal);
    } finally {
      operation.end();
    }
  }

  /** Aborts every running operation and refuses new ones. */
  dispose(): void {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }
}
