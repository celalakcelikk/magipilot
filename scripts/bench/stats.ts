// Pure statistics and scoring for the bench (unit-tested in test/unit/stats.test.ts).

/** Nearest-rank percentile (p in 0..100) of the given values; undefined for an empty list. */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** 1 − normalized Levenshtein distance; 1 means identical. */
export function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/**
 * Plan §4.3 scoring normalization: only trailing whitespace (per line and at the end) is ignored.
 * Leading whitespace and leading newlines are kept — inserted at the cursor they change the code.
 */
export function normalizeForScore(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n+$/, '');
}

/**
 * Additionally ignores leading whitespace/newlines. Reported separately ("loose" exact match):
 * it shows what indentation post-processing (Faz 1) could recover, not what the model produced.
 */
export function normalizeLoose(text: string): string {
  return normalizeForScore(text).trimStart();
}

/** Removes one surrounding markdown code fence, the only cleaning the bench applies. */
export function stripFence(text: string): string {
  const match = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return match ? match[1]! : text;
}

export function exactMatch(actual: string, expected: string): boolean {
  return normalizeForScore(actual) === normalizeForScore(expected);
}

/** Bumped whenever the scoring rules change; stored with rescored results. */
export const SCORING_VERSION = 2;

export function scoreCompletion(
  raw: string,
  expected: string,
): { cleaned: string; exact: boolean; exactLoose: boolean; similarity: number } {
  const cleaned = stripFence(raw);
  return {
    cleaned,
    exact: exactMatch(cleaned, expected),
    exactLoose: normalizeLoose(cleaned) === normalizeLoose(expected),
    similarity: editSimilarity(normalizeForScore(cleaned), normalizeForScore(expected)),
  };
}

export interface RowStats {
  attempts: number;
  ok: number;
  errors: number;
  p50TotalMs?: number;
  p95TotalMs?: number;
  p50FirstTextMs?: number;
  p95FirstTextMs?: number;
  exactMatches: number;
  exactLooseMatches: number;
  meanSimilarity?: number;
  /** Production rows only: strict exact matches after postprocess. */
  exactProcessedMatches?: number;
}

export interface RequestOutcome {
  ok: boolean;
  totalMs?: number;
  firstTextMs?: number;
  exact?: boolean;
  exactLoose?: boolean;
  similarity?: number;
  exactProcessed?: boolean;
}

export function summarizeRow(outcomes: readonly RequestOutcome[]): RowStats {
  const ok = outcomes.filter((o) => o.ok);
  const totals = ok.flatMap((o) => (o.totalMs !== undefined ? [o.totalMs] : []));
  const firsts = ok.flatMap((o) => (o.firstTextMs !== undefined ? [o.firstTextMs] : []));
  return {
    attempts: outcomes.length,
    ok: ok.length,
    errors: outcomes.length - ok.length,
    p50TotalMs: percentile(totals, 50),
    p95TotalMs: percentile(totals, 95),
    p50FirstTextMs: percentile(firsts, 50),
    p95FirstTextMs: percentile(firsts, 95),
    exactMatches: ok.filter((o) => o.exact).length,
    exactLooseMatches: ok.filter((o) => o.exactLoose).length,
    meanSimilarity: mean(ok.flatMap((o) => (o.similarity !== undefined ? [o.similarity] : []))),
    exactProcessedMatches: ok.some((o) => o.exactProcessed !== undefined)
      ? ok.filter((o) => o.exactProcessed).length
      : undefined,
  };
}

export const MIN_SUCCESSES = 18;
export const MAX_SIMILARITY_GAP = 0.05;
export const SESSION_MIN_ADVANTAGE = 0.2;

export type WarmVsSessionDecision =
  | { verdict: 'warm-pool'; reason: string }
  | { verdict: 'session'; reason: string }
  | { verdict: 'inconclusive'; reason: string };

/**
 * Plan §4.3 decision rule: evidence gate first (≥ 18 successes per mode, mean edit similarity
 * within 0.05), then prefer the warm pool unless the session's p50 is more than 20 % lower.
 */
export function decideWarmVsSession(warm: RowStats, session: RowStats): WarmVsSessionDecision {
  const gaps: string[] = [];
  if (warm.ok < MIN_SUCCESSES)
    gaps.push(`warm pool has only ${warm.ok}/${warm.attempts} successes`);
  if (session.ok < MIN_SUCCESSES) {
    gaps.push(`session has only ${session.ok}/${session.attempts} successes`);
  }
  if (warm.meanSimilarity === undefined || session.meanSimilarity === undefined) {
    gaps.push('quality is missing for at least one mode');
  } else if (Math.abs(warm.meanSimilarity - session.meanSimilarity) > MAX_SIMILARITY_GAP) {
    gaps.push(
      `mean edit similarity differs by ${Math.abs(warm.meanSimilarity - session.meanSimilarity).toFixed(3)} (> ${MAX_SIMILARITY_GAP})`,
    );
  }
  if (warm.p50TotalMs === undefined || session.p50TotalMs === undefined) {
    gaps.push('latency is missing for at least one mode');
  }
  if (gaps.length > 0) {
    return { verdict: 'inconclusive', reason: gaps.join('; ') };
  }
  const warmP50 = warm.p50TotalMs!;
  const sessionP50 = session.p50TotalMs!;
  const advantage = (warmP50 - sessionP50) / warmP50;
  if (advantage > SESSION_MIN_ADVANTAGE) {
    return {
      verdict: 'session',
      reason: `session p50 ${sessionP50} ms is ${(advantage * 100).toFixed(0)} % lower than warm pool p50 ${warmP50} ms`,
    };
  }
  return {
    verdict: 'warm-pool',
    reason: `session p50 ${sessionP50} ms vs warm pool p50 ${warmP50} ms: advantage ${(advantage * 100).toFixed(0)} % ≤ ${SESSION_MIN_ADVANTAGE * 100} %`,
  };
}
