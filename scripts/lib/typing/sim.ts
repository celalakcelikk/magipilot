// Typing-replay simulation for the debounce tuning (docs/plans/phase-3-metrics.md M4, AC4).
// Pure: no I/O, no backend call. A seeded typing model turns a code file into keystrokes; each
// keystroke is one automatic provider call, modelled like src/features/inline/provider.ts:
// - the next keystroke cancels the call; cancelled during the debounce → no request;
// - otherwise a request is sent after the debounce and answers after a latency drawn from the
//   recorded bench runs; it is shown if it answers before the next keystroke, else it is a
//   wasted (cancelled) request.
// The cache's working set is bounded by the suggestions that could still be typed through.
// Not modelled (docs/bench.md): typing through a shown suggestion (cache hits), the wait for an
// aborted CLI process to die (P1-I016), and a warm-pool worker being replaced after an abort.

/** mulberry32: a small seeded PRNG, uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface TypingModel {
  name: string;
  description: string;
  /** Gap after a keystroke inside a burst. */
  burstGapMs(rand: () => number): number;
  /** Range of a pause after a word or a line. */
  pauseMs: readonly [number, number];
  /** Chance of a pause after a word end; a line end always pauses. */
  wordPauseProbability: number;
}

const uniform = (rand: () => number, lo: number, hi: number): number => lo + (hi - lo) * rand();

/** The model of the approved plan (M4): bursts 80–250 ms apart, pauses 600–2500 ms. */
export const M4_MODEL: TypingModel = {
  name: 'm4',
  description:
    'bursts: uniform 80–250 ms between keys; pause: uniform 600–2500 ms after every line and after 25 % of word ends',
  burstGapMs: (rand) => uniform(rand, 80, 250),
  pauseMs: [600, 2500],
  wordPauseProbability: 0.25,
};

/**
 * Sensitivity variant, not the M4 model: heavier-tailed gaps inside a burst (log-normal, median
 * 180 ms, σ 0.5, capped below the pause range), so some gaps exceed the 250 ms cap of M4.
 */
export const HEAVY_TAIL_MODEL: TypingModel = {
  name: 'heavy-tail',
  description:
    'bursts: log-normal between keys (median 180 ms, σ 0.5, at most 599 ms); pauses as in M4',
  burstGapMs: (rand) => {
    // Box–Muller from two uniforms; 1 - rand() avoids log(0).
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    return Math.min(599, 180 * Math.exp(0.5 * z));
  },
  pauseMs: [600, 2500],
  wordPauseProbability: 0.25,
};

export interface Keystroke {
  /** Line of the typed character (0-based). */
  line: number;
  /** Time until the next keystroke (or the end of the session). */
  gapMs: number;
  /** The gap is a pause of the typing model (after a word or a line). */
  pause: boolean;
}

const IDENTIFIER = /[A-Za-z0-9_]/;

/**
 * The keystrokes of typing `text` from top to bottom. Leading indentation is left out (the editor
 * indents a new line); a line end and the end of the text pause; a word end (a character that
 * ends an identifier) pauses with the model's probability.
 */
export function keystrokes(text: string, model: TypingModel, rand: () => number): Keystroke[] {
  const typed = text
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n')
    .replace(/\n+$/, '');
  const result: Keystroke[] = [];
  let line = 0;
  for (let i = 0; i < typed.length; i++) {
    const char = typed[i]!;
    const last = i === typed.length - 1;
    const wordEnd = !IDENTIFIER.test(char) && i > 0 && IDENTIFIER.test(typed[i - 1]!);
    const pause = last || char === '\n' || (wordEnd && rand() < model.wordPauseProbability);
    result.push({
      line,
      gapMs: pause ? uniform(rand, model.pauseMs[0], model.pauseMs[1]) : model.burstGapMs(rand),
      pause,
    });
    if (char === '\n') line++;
  }
  return result;
}

/** One latency per keystroke, drawn with replacement from the recorded latencies. */
export function drawLatencies(
  count: number,
  recorded: readonly number[],
  rand: () => number,
): number[] {
  if (recorded.length === 0) throw new Error('no recorded latencies');
  return Array.from({ length: count }, () => recorded[Math.floor(rand() * recorded.length)]!);
}

export interface SessionResult {
  keystrokes: number;
  /** Requests that reached the backend. */
  requests: number;
  /** Requests cancelled by the next keystroke before their answer. */
  wasted: number;
  /** Answers that arrived before the next keystroke (each is also stored in the cache). */
  shown: number;
  pauses: number;
  /** Pauses that got a suggestion before the next keystroke. */
  pausesServed: number;
  /** Debounce + latency for every pause: when the suggestion would appear after the last key. */
  timeToSuggestionAfterPause: number[];
  /**
   * Most cached completions that could still be hit at one time: a suggestion spans at most
   * `maxLines` lines, so typing through it ends `maxLines` lines below its anchor.
   */
  maxLiveEntries: number;
}

/** Replays one typing session against one debounce and the drawn latencies (one per keystroke). */
export function simulate(
  keys: readonly Keystroke[],
  debounceMs: number,
  latencies: readonly number[],
  maxLines: number,
): SessionResult {
  const result: SessionResult = {
    keystrokes: keys.length,
    requests: 0,
    wasted: 0,
    shown: 0,
    pauses: 0,
    pausesServed: 0,
    timeToSuggestionAfterPause: [],
    maxLiveEntries: 0,
  };
  // Anchor lines of the stored completions, in typing order (never decreasing).
  const anchors: number[] = [];
  let firstLive = 0;
  keys.forEach((key, i) => {
    while (firstLive < anchors.length && anchors[firstLive]! <= key.line - maxLines) firstLive++;
    const latency = latencies[i]!;
    const answeredAt = debounceMs + latency;
    if (key.pause) {
      result.pauses++;
      result.timeToSuggestionAfterPause.push(answeredAt);
    }
    if (key.gapMs <= debounceMs) return; // cancelled while debouncing: nothing sent
    result.requests++;
    if (answeredAt < key.gapMs) {
      result.shown++;
      if (key.pause) result.pausesServed++;
      anchors.push(key.line);
      result.maxLiveEntries = Math.max(result.maxLiveEntries, anchors.length - firstLive);
    } else {
      result.wasted++;
    }
  });
  return result;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface RunSummary {
  requestsPer100: number;
  wastedPer100: number;
  shownPer100: number;
  pausesServedPct: number;
  /** p50 of debounce + latency over the pauses. */
  timeToSuggestionP50Ms: number;
  /** Most completions one file session stores in the cache. */
  maxStoredPerFile: number;
  /** Most stored completions that could still be hit at one time (the working set). */
  maxLiveEntries: number;
}

/** Totals of one seed's file sessions. */
export function summarize(sessions: readonly SessionResult[]): RunSummary {
  const sum = (pick: (s: SessionResult) => number): number =>
    sessions.reduce((total, s) => total + pick(s), 0);
  const keys = sum((s) => s.keystrokes);
  const pauses = sum((s) => s.pauses);
  return {
    requestsPer100: (100 * sum((s) => s.requests)) / keys,
    wastedPer100: (100 * sum((s) => s.wasted)) / keys,
    shownPer100: (100 * sum((s) => s.shown)) / keys,
    pausesServedPct: pauses === 0 ? Number.NaN : (100 * sum((s) => s.pausesServed)) / pauses,
    timeToSuggestionP50Ms: median(sessions.flatMap((s) => s.timeToSuggestionAfterPause)),
    maxStoredPerFile: Math.max(0, ...sessions.map((s) => s.shown)),
    maxLiveEntries: Math.max(0, ...sessions.map((s) => s.maxLiveEntries)),
  };
}

/** Median of each field across seeds. */
export function medianSummary(runs: readonly RunSummary[]): RunSummary {
  const field = (pick: (r: RunSummary) => number): number => median(runs.map(pick));
  return {
    requestsPer100: field((r) => r.requestsPer100),
    wastedPer100: field((r) => r.wastedPer100),
    shownPer100: field((r) => r.shownPer100),
    pausesServedPct: field((r) => r.pausesServedPct),
    timeToSuggestionP50Ms: field((r) => r.timeToSuggestionP50Ms),
    maxStoredPerFile: Math.max(...runs.map((r) => r.maxStoredPerFile)),
    maxLiveEntries: Math.max(...runs.map((r) => r.maxLiveEntries)),
  };
}

export interface Verdict {
  candidateMs: number;
  /** 1 − wasted(candidate) / wasted(default); 0 when the default wastes nothing. */
  wasteCut: number;
  timeToSuggestionGrowthMs: number;
  pass: boolean;
}

/**
 * The M4 rule for one backend: a candidate passes if it cuts wasted requests by at least 25 %
 * while the p50 time to suggestion after a pause grows by at most `maxGrowthMs`.
 */
export function verdict(
  baseline: RunSummary,
  candidate: RunSummary,
  candidateMs: number,
  maxGrowthMs: number,
): Verdict {
  const wasteCut =
    baseline.wastedPer100 === 0 ? 0 : 1 - candidate.wastedPer100 / baseline.wastedPer100;
  const timeToSuggestionGrowthMs = candidate.timeToSuggestionP50Ms - baseline.timeToSuggestionP50Ms;
  return {
    candidateMs,
    wasteCut,
    timeToSuggestionGrowthMs,
    pass: wasteCut >= 0.25 && timeToSuggestionGrowthMs <= maxGrowthMs,
  };
}
