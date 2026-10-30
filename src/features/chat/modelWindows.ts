// The context window Claude Code reports per model (docs/plans/phase-4-context.md W1, W2).
// vscode-free.
//
// Only `rawMaxTokens` is read from the `get_context_usage` answer. Its token categories, grid and
// counts never leave the parser, and nothing raw is logged or stored (W6).
import type { DiscoveryFailure } from './modelDiscovery';
import { isModelId, windowOf } from './models';

/** The `request_id` of the window request; only its answer is read. */
export const WINDOW_REQUEST_ID = 'magipilot-window';
/** A known window is read again after this long; the old one is used meanwhile (W2). */
export const WINDOW_REFRESH_MS = 24 * 60 * 60_000;
/** A failed read is not repeated for this long (W2). */
export const WINDOW_RETRY_MS = 10 * 60_000;
/** Reads running at once (W1). */
export const WINDOW_CONCURRENCY = 2;
/** Entries kept in the store, the most recently read first (W2). */
export const MAX_STORED_WINDOWS = 200;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The window of the `get_context_usage` answer with `requestId`: its `rawMaxTokens` when that is
 * a window Magipilot takes (64 000 to 2 000 000), else null. Undefined for every other line.
 */
export function claudeWindowFromLine(line: string, requestId: string): number | null | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(event) || event.type !== 'control_response') return undefined;
  const outer = isObject(event.response) ? event.response : undefined;
  if (outer?.request_id !== requestId) return undefined;
  if (outer.subtype !== 'success' || !isObject(outer.response)) return null;
  return windowOf(outer.response.rawMaxTokens) ?? null;
}

export interface StoredWindow {
  /** The CLI's executable path, as configured. */
  path: string;
  model: string;
  window: number;
  /** When it was read (ms since the epoch). */
  at: number;
}

/** A stored list, checked again: `globalState` is data from disk (W2). */
export function sanitizeWindows(value: unknown): StoredWindow[] {
  if (!Array.isArray(value)) return [];
  const result: StoredWindow[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry)) continue;
    const { path, model, at } = entry;
    const window = windowOf(entry.window);
    if (typeof path !== 'string' || path === '' || path.length > 4096) continue;
    if (typeof model !== 'string' || !isModelId(model) || window === undefined) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue;
    const key = keyOf(path, model);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ path, model, window, at });
    if (result.length >= MAX_STORED_WINDOWS) break;
  }
  return result;
}

function keyOf(path: string, model: string): string {
  return `${path}\0${model}`;
}

export interface ClaudeWindowsDeps {
  /** Reads one model's window from the CLI (`probeClaudeWindow`). */
  read(path: string, model: string): Promise<number | DiscoveryFailure>;
  store?: { get(): unknown; set(windows: StoredWindow[]): void };
  /**
   * New or changed windows arrived: the picker should ask again. `shrunk` is reported at once, for
   * each window that became smaller than before (or than `assumed` when none was known), so a
   * request prepared for the old budget is refused (P4PICK-I003, I004); the end of a batch reports
   * the rest with `shrunk` false.
   */
  onChange(shrunk: boolean): void;
  /** The window assumed while none is known (Claude's 200 000). */
  assumed?: number;
  log(event: { asked: number; windows: number; failures: number; ms: number }): void;
  now?(): number;
}

interface Job {
  path: string;
  model: string;
  key: string;
}

/**
 * The windows per CLI path and model (W2). `window()` answers from memory or the store at once;
 * `request()` reads the missing and stale ones in the background, two at a time, and calls
 * `onChange` once a batch has brought anything new.
 */
export class ClaudeWindows {
  private loaded = false;
  private readonly known = new Map<
    string,
    { path: string; model: string; window: number; at: number }
  >();
  private readonly failedAt = new Map<string, number>();
  private readonly queue: Job[] = [];
  /** Keys queued or being read. */
  private readonly pending = new Set<string>();
  private active = 0;
  /** Callers of `settle()` waiting for the running reads to end. */
  private readonly waiters: (() => void)[] = [];
  private batch?: {
    started: number;
    asked: number;
    windows: number;
    failures: number;
    changed: boolean;
  };
  private disposed = false;

  constructor(private readonly deps: ClaudeWindowsDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const entry of sanitizeWindows(this.deps.store?.get())) {
      this.known.set(keyOf(entry.path, entry.model), entry);
    }
  }

  /** The known window of `model`, also a stale one; undefined when none was read. */
  window(path: string, model: string): number | undefined {
    this.load();
    return this.known.get(keyOf(path, model))?.window;
  }

  /** Reads, in the background, the windows of `models` that are missing or older than a day. */
  request(path: string, models: readonly string[]): void {
    if (this.disposed) return;
    this.load();
    const now = this.now();
    for (const model of models) {
      if (!isModelId(model)) continue;
      const key = keyOf(path, model);
      if (this.pending.has(key)) continue;
      const entry = this.known.get(key);
      if (entry && now - entry.at < WINDOW_REFRESH_MS) continue;
      const failed = this.failedAt.get(key);
      if (failed !== undefined && now - failed < WINDOW_RETRY_MS) continue;
      this.pending.add(key);
      this.queue.push({ path, model, key });
    }
    this.pump();
  }

  private pump(): void {
    while (!this.disposed && this.active < WINDOW_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.batch ??= {
        started: this.now(),
        asked: 0,
        windows: 0,
        failures: 0,
        changed: false,
      };
      this.active++;
      void this.readOne(job).finally(() => {
        this.active--;
        this.pending.delete(job.key);
        if (this.queue.length > 0) this.pump();
        else if (this.active === 0) {
          this.endBatch();
          for (const resolve of this.waiters.splice(0)) resolve();
        }
      });
    }
  }

  private async readOne(job: Job): Promise<void> {
    let result: number | DiscoveryFailure;
    try {
      result = await this.deps.read(job.path, job.model);
    } catch {
      result = 'unreadable';
    }
    const batch = this.batch;
    if (this.disposed || !batch) return;
    batch.asked++;
    const window = typeof result === 'number' ? windowOf(result) : undefined;
    if (window === undefined) {
      this.failedAt.set(job.key, this.now());
      batch.failures++;
      return;
    }
    const before = this.known.get(job.key)?.window;
    this.known.set(job.key, { path: job.path, model: job.model, window, at: this.now() });
    this.failedAt.delete(job.key);
    batch.windows++;
    if (before !== window) batch.changed = true;
    const previous = before ?? this.deps.assumed;
    // A smaller budget is visible from now on: reported at once, not at the batch's end (I004).
    if (previous !== undefined && window < previous) this.deps.onChange(true);
  }

  private endBatch(): void {
    const batch = this.batch;
    this.batch = undefined;
    if (this.disposed || !batch) return;
    this.deps.log({
      asked: batch.asked,
      windows: batch.windows,
      failures: batch.failures,
      ms: this.now() - batch.started,
    });
    if (batch.windows > 0) {
      const newest = [...this.known.values()]
        .sort((a, b) => b.at - a.at)
        .slice(0, MAX_STORED_WINDOWS)
        .map(({ path, model, window, at }) => ({ path, model, window, at }));
      this.deps.store?.set(newest);
    }
    if (batch.changed) this.deps.onChange(false);
  }

  /**
   * Settings changed (discovery, the CLI path, trust): the queued reads are dropped, so none starts
   * under settings that no longer allow it (inspection P4CTX-I001). Running reads end within the
   * probe timeout and are kept, as reads of their own path and model. A read the new settings
   * still allow is queued again by the next `request()`.
   */
  invalidate(): void {
    for (const job of this.queue) this.pending.delete(job.key);
    this.queue.length = 0;
  }

  /** Resolves once no read runs (tests: a read must not outlive the test that started it). */
  settle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Forgets everything of this session (tests; the store is cleared by its owner). */
  clear(): void {
    this.known.clear();
    this.failedAt.clear();
    this.queue.length = 0;
    this.loaded = true;
  }

  /** No more reads start; the registry kills those still running. */
  dispose(): void {
    this.disposed = true;
    this.queue.length = 0;
  }
}
