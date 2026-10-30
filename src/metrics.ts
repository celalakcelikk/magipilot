// Local statistics for `Magipilot: Show Stats` (PLAN §6.7, docs/plans/phase-3-metrics.md). Kept in
// memory for the window's lifetime only, never stored or sent anywhere (PLAN §2.4, M2, M5).
// Inline: backend requests and their outcomes are counted apart from the suggestions returned to
// VS Code (AC3), so the acceptance rate (accepted ÷ shown) cannot exceed 100 %.

export type BackendOutcome = 'completion' | 'empty' | 'error' | 'cancelled';

export interface BackendStats {
  /** Requests that reached the backend, and their outcomes. */
  requests: number;
  completions: number;
  empty: number;
  errors: number;
  /** Requests that reached the backend and were cancelled or superseded. */
  cancelled: number;
  /** Backend latency of completions and empty answers. */
  p50Ms?: number;
  p95Ms?: number;
  /** Suggestions returned to VS Code, from the backend or the cache. */
  shown: number;
  /** Of `shown`, the ones that came from the cache. */
  cacheHits: number;
  accepted: number;
  /** accepted ÷ shown, at most 1; undefined before the first shown suggestion. */
  acceptanceRate?: number;
  /** From the provider call to the returned suggestion, debounce included. */
  timeToSuggestionP50Ms?: number;
}

export interface ChatModelStats {
  requests: number;
  complete: number;
  cancelled: number;
  errors: number;
  p50Ms?: number;
}

const MAX_SAMPLES = 500;

function percentile(samples: readonly number[], p: number): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function pushSample(samples: number[], ms: number): void {
  samples.push(ms);
  if (samples.length > MAX_SAMPLES) samples.shift();
}

interface InlineCounters {
  requests: number;
  completions: number;
  empty: number;
  errors: number;
  cancelled: number;
  latencies: number[];
  shown: number;
  cacheHits: number;
  accepted: number;
  timeToSuggestion: number[];
}

export class Metrics {
  private readonly perBackend = new Map<string, InlineCounters>();

  private counters(backend: string): InlineCounters {
    let counters = this.perBackend.get(backend);
    if (!counters) {
      counters = {
        requests: 0,
        completions: 0,
        empty: 0,
        errors: 0,
        cancelled: 0,
        latencies: [],
        shown: 0,
        cacheHits: 0,
        accepted: 0,
        timeToSuggestion: [],
      };
      this.perBackend.set(backend, counters);
    }
    return counters;
  }

  /** One request that reached the backend and ended with `outcome`. */
  recordRequest(backend: string, outcome: BackendOutcome, ms: number): void {
    const counters = this.counters(backend);
    counters.requests++;
    if (outcome === 'completion') counters.completions++;
    else if (outcome === 'empty') counters.empty++;
    else if (outcome === 'error') counters.errors++;
    else counters.cancelled++;
    if (outcome === 'completion' || outcome === 'empty') pushSample(counters.latencies, ms);
  }

  /**
   * One suggestion returned to VS Code (after its cancellation and ownership checks), from the
   * backend or the cache; `ms` is the time since the provider was called.
   */
  recordShown(backend: string, shown: { fromCache: boolean; ms: number }): void {
    const counters = this.counters(backend);
    counters.shown++;
    if (shown.fromCache) counters.cacheHits++;
    pushSample(counters.timeToSuggestion, shown.ms);
  }

  /** The user accepted a suggestion of `backend`. */
  recordAccepted(backend: string): void {
    this.counters(backend).accepted++;
  }

  reset(): void {
    this.perBackend.clear();
  }

  snapshot(): Record<string, BackendStats> {
    const result: Record<string, BackendStats> = {};
    for (const [backend, c] of this.perBackend) {
      result[backend] = {
        requests: c.requests,
        completions: c.completions,
        empty: c.empty,
        errors: c.errors,
        cancelled: c.cancelled,
        p50Ms: percentile(c.latencies, 50),
        p95Ms: percentile(c.latencies, 95),
        shown: c.shown,
        cacheHits: c.cacheHits,
        accepted: c.accepted,
        acceptanceRate: c.shown > 0 ? Math.min(1, c.accepted / c.shown) : undefined,
        timeToSuggestionP50Ms: percentile(c.timeToSuggestion, 50),
      };
    }
    return result;
  }
}

interface ChatCounters {
  requests: number;
  complete: number;
  cancelled: number;
  errors: number;
  durations: number[];
}

/**
 * Chat requests per model for the window's lifetime, apart from the provider's bounded diagnostic
 * history, so the counts keep growing after 200 requests (METRICS-003).
 */
export class ChatStats {
  private readonly perModel = new Map<string, ChatCounters>();

  record(model: string, outcome: 'complete' | 'cancelled' | 'error', ms: number): void {
    let counters = this.perModel.get(model);
    if (!counters) {
      counters = { requests: 0, complete: 0, cancelled: 0, errors: 0, durations: [] };
      this.perModel.set(model, counters);
    }
    counters.requests++;
    if (outcome === 'complete') counters.complete++;
    else if (outcome === 'cancelled') counters.cancelled++;
    else counters.errors++;
    pushSample(counters.durations, ms);
  }

  reset(): void {
    this.perModel.clear();
  }

  snapshot(): Record<string, ChatModelStats> {
    const result: Record<string, ChatModelStats> = {};
    for (const [model, c] of this.perModel) {
      result[model] = {
        requests: c.requests,
        complete: c.complete,
        cancelled: c.cancelled,
        errors: c.errors,
        p50Ms: percentile(c.durations, 50),
      };
    }
    return result;
  }
}
