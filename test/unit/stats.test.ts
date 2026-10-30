import { describe, expect, it } from 'vitest';
import {
  decideWarmVsSession,
  editSimilarity,
  exactMatch,
  levenshtein,
  mean,
  normalizeForScore,
  normalizeLoose,
  percentile,
  scoreCompletion,
  stripFence,
  summarizeRow,
  type RowStats,
} from '../../scripts/bench/stats';

describe('percentile (nearest rank)', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200

  it('returns undefined for no values', () => {
    expect(percentile([], 50)).toBeUndefined();
  });

  it('uses the nearest-rank definition', () => {
    expect(percentile(twenty, 50)).toBe(100); // rank 10
    expect(percentile(twenty, 95)).toBe(190); // rank 19
    expect(percentile(twenty, 100)).toBe(200);
    expect(percentile([7], 95)).toBe(7);
  });

  it('does not depend on input order', () => {
    expect(percentile([...twenty].reverse(), 50)).toBe(100);
  });
});

describe('mean', () => {
  it('averages and handles empty input', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeUndefined();
  });
});

describe('levenshtein / editSimilarity', () => {
  it('computes classic distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });

  it('normalizes similarity to 0..1', () => {
    expect(editSimilarity('', '')).toBe(1);
    expect(editSimilarity('abc', 'abc')).toBe(1);
    expect(editSimilarity('abc', 'xyz')).toBe(0);
    expect(editSimilarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
  });
});

describe('cleaning and exact match', () => {
  it('strips exactly one surrounding fence', () => {
    expect(stripFence('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
    expect(stripFence('```\nx\n```\n')).toBe('x');
    expect(stripFence('no fence')).toBe('no fence');
    expect(stripFence('before ```ts\ncode\n``` after')).toBe('before ```ts\ncode\n``` after');
  });

  it('ignores only trailing whitespace (plan §4.3), never leading indentation', () => {
    expect(normalizeForScore('    return x;  \n\n')).toBe('    return x;');
    expect(normalizeForScore('\nreturn x;')).toBe('\nreturn x;');
    expect(exactMatch('return a + b;  \n', 'return a + b;')).toBe(true);
    // Review P0-I005: an extra indent inserted at the cursor yields invalid code — not a match.
    expect(exactMatch('    return a + b;\n', 'return a + b;')).toBe(false);
    expect(exactMatch('return a - b;', 'return a + b;')).toBe(false);
  });

  it('reports the indentation-insensitive match separately as "loose"', () => {
    expect(normalizeLoose('\n    return x;  \n')).toBe('return x;');
    const score = scoreCompletion('       return fib(n - 1)', 'return fib(n - 1)');
    expect(score.exact).toBe(false);
    expect(score.exactLoose).toBe(true);
    expect(score.similarity).toBeLessThan(1);
  });

  it('scores a fenced completion against the expected text', () => {
    const score = scoreCompletion('```python\nreturn n\n```', 'return n');
    expect(score.cleaned).toBe('return n');
    expect(score.exact).toBe(true);
    expect(score.exactLoose).toBe(true);
    expect(score.similarity).toBe(1);
  });
});

describe('summarizeRow', () => {
  it('computes latency only over successful requests and counts errors', () => {
    const stats = summarizeRow([
      { ok: true, totalMs: 100, firstTextMs: 50, exact: true, exactLoose: true, similarity: 1 },
      { ok: true, totalMs: 300, firstTextMs: 70, exact: false, exactLoose: true, similarity: 0.5 },
      { ok: false, totalMs: 1 },
    ]);
    expect(stats).toMatchObject({
      attempts: 3,
      ok: 2,
      errors: 1,
      p50TotalMs: 100,
      p95TotalMs: 300,
      exactMatches: 1,
      exactLooseMatches: 2,
      meanSimilarity: 0.75,
    });
  });
});

describe('decideWarmVsSession (plan §4.3 rule with evidence gate)', () => {
  const row = (overrides: Partial<RowStats>): RowStats => ({
    attempts: 20,
    ok: 20,
    errors: 0,
    p50TotalMs: 1000,
    p95TotalMs: 1500,
    exactLooseMatches: 10,
    exactMatches: 10,
    meanSimilarity: 0.8,
    ...overrides,
  });

  it('is inconclusive when a fast session has only one success (review P0-004)', () => {
    const decision = decideWarmVsSession(
      row({}),
      row({ ok: 1, errors: 19, p50TotalMs: 100, meanSimilarity: 0.8 }),
    );
    expect(decision.verdict).toBe('inconclusive');
    expect(decision.reason).toContain('session has only 1/20');
  });

  it('is inconclusive when quality differs by more than 0.05', () => {
    const decision = decideWarmVsSession(row({}), row({ p50TotalMs: 500, meanSimilarity: 0.7 }));
    expect(decision.verdict).toBe('inconclusive');
  });

  it('chooses the session only when it is more than 20 % faster', () => {
    expect(decideWarmVsSession(row({}), row({ p50TotalMs: 700 })).verdict).toBe('session');
    expect(decideWarmVsSession(row({}), row({ p50TotalMs: 850 })).verdict).toBe('warm-pool');
    expect(decideWarmVsSession(row({}), row({ p50TotalMs: 1200 })).verdict).toBe('warm-pool');
  });
});
