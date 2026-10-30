import { describe, expect, it } from 'vitest';
import {
  drawLatencies,
  HEAVY_TAIL_MODEL,
  keystrokes,
  M4_MODEL,
  median,
  mulberry32,
  simulate,
  summarize,
  verdict,
  type Keystroke,
  type TypingModel,
} from '../../scripts/lib/typing/sim';

const NEVER_WORD_PAUSE: TypingModel = { ...M4_MODEL, wordPauseProbability: 0 };
const ALWAYS_WORD_PAUSE: TypingModel = { ...M4_MODEL, wordPauseProbability: 1 };

describe('mulberry32', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(values);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(mulberry32(43)()).not.toBe(values[0]);
  });
});

describe('keystrokes', () => {
  it('leaves out indentation, tracks lines and pauses after every line and at the end', () => {
    const keys = keystrokes('ab\n  c\n', NEVER_WORD_PAUSE, mulberry32(1));
    // Typed: "ab\nc" — the indentation and the trailing newline are left out.
    expect(keys.map((k) => k.line)).toEqual([0, 0, 0, 1]);
    expect(keys.map((k) => k.pause)).toEqual([false, false, true, true]);
    for (const key of keys) {
      if (key.pause) expect(key.gapMs).toBeGreaterThanOrEqual(600);
      else expect(key.gapMs).toBeLessThanOrEqual(250);
    }
  });

  it('pauses at word ends with the model probability', () => {
    const text = 'foo(bar) + baz;';
    const pauses = (model: TypingModel): boolean[] =>
      keystrokes(text, model, mulberry32(7)).map((k) => k.pause);
    // Word ends are the characters right after an identifier: "(", ")" and ";" here.
    expect(pauses(ALWAYS_WORD_PAUSE)).toEqual(
      [...text].map((c, i) => i === text.length - 1 || ['(', ')', ';'].includes(c)),
    );
    expect(pauses(NEVER_WORD_PAUSE).filter(Boolean)).toHaveLength(1);
  });

  it('M4 gaps stay in 80–250 ms inside a burst; the sensitivity variant exceeds 250 ms sometimes', () => {
    const text = 'x'.repeat(5000);
    const m4 = keystrokes(text, NEVER_WORD_PAUSE, mulberry32(3)).slice(0, -1);
    expect(m4.every((k) => k.gapMs >= 80 && k.gapMs <= 250)).toBe(true);
    const heavy = keystrokes(text, { ...HEAVY_TAIL_MODEL, wordPauseProbability: 0 }, mulberry32(3))
      .slice(0, -1)
      .map((k) => k.gapMs);
    expect(heavy.some((g) => g > 250)).toBe(true);
    expect(heavy.every((g) => g < 600)).toBe(true);
    expect(median(heavy)).toBeGreaterThan(160);
    expect(median(heavy)).toBeLessThan(200);
  });
});

describe('simulate', () => {
  const key = (gapMs: number, pause = false, line = 0): Keystroke => ({ gapMs, pause, line });

  it('sends nothing while debouncing, shows answers before the next key, wastes the rest', () => {
    const result = simulate(
      [key(100), key(300), key(1000, true), key(2000, true)],
      200,
      [50, 50, 900, 100],
      8,
    );
    expect(result).toEqual({
      keystrokes: 4,
      requests: 3, // the first key is followed within the debounce
      wasted: 1, // 200 + 900 ≥ 1000
      shown: 2,
      pauses: 2,
      pausesServed: 1,
      timeToSuggestionAfterPause: [1100, 300],
      maxLiveEntries: 2,
    });
  });

  it('counts as live only the completions anchored within maxLines lines', () => {
    const keys = Array.from({ length: 20 }, (_, line) => key(1000, true, line));
    const result = simulate(keys, 100, new Array<number>(20).fill(10), 8);
    expect(result.shown).toBe(20);
    expect(result.maxLiveEntries).toBe(8);
  });
});

describe('summarize, verdict and determinism', () => {
  it('reports per 100 keystrokes and the most stored completions of one file', () => {
    const a = simulate([{ gapMs: 1000, pause: true, line: 0 }], 200, [100], 8);
    const b = simulate(
      [
        { gapMs: 100, pause: false, line: 0 },
        { gapMs: 1000, pause: true, line: 0 },
      ],
      200,
      [100, 2000],
      8,
    );
    const summary = summarize([a, b]);
    expect(summary.requestsPer100).toBeCloseTo((100 * 2) / 3);
    expect(summary.wastedPer100).toBeCloseTo(100 / 3);
    expect(summary.shownPer100).toBeCloseTo(100 / 3);
    expect(summary.pausesServedPct).toBe(50);
    expect(summary.maxStoredPerFile).toBe(1);
  });

  it('applies the M4 rule: a cut of at least 25 % within the allowed growth', () => {
    const base = summarize([simulate([{ gapMs: 220, pause: false, line: 0 }], 200, [100], 8)]);
    const none = summarize([simulate([{ gapMs: 220, pause: false, line: 0 }], 250, [100], 8)]);
    expect(verdict(base, none, 250, 100)).toEqual({
      candidateMs: 250,
      wasteCut: 1,
      timeToSuggestionGrowthMs: Number.NaN, // no pause to measure: the rule fails
      pass: false,
    });
    const withPause = (d: number) =>
      summarize([
        simulate(
          [
            { gapMs: 220, pause: false, line: 0 },
            { gapMs: 2000, pause: true, line: 0 },
          ],
          d,
          [100, 100],
          8,
        ),
      ]);
    expect(verdict(withPause(200), withPause(250), 250, 100).pass).toBe(true);
    expect(verdict(withPause(200), withPause(250), 250, 49).pass).toBe(false);
  });

  it('gives the same result for the same seed', () => {
    const run = (): unknown => {
      const keys = keystrokes('const x = foo(bar);\nreturn x;\n', M4_MODEL, mulberry32(11));
      const latencies = drawLatencies(keys.length, [300, 400, 1500], mulberry32(12));
      return simulate(keys, 250, latencies, 8);
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
