// Claude's context windows (docs/plans/phase-4-context.md W1, W2, W6).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ClaudeWindows,
  claudeWindowFromLine,
  MAX_STORED_WINDOWS,
  sanitizeWindows,
  WINDOW_REFRESH_MS,
  WINDOW_REQUEST_ID,
  WINDOW_RETRY_MS,
  type StoredWindow,
} from '../../src/features/chat/modelWindows';
import type { DiscoveryFailure } from '../../src/features/chat/modelDiscovery';

/** The real answer of Claude Code 2.1.312 for `--model sonnet`, trimmed (one grid row). */
const REAL = readFileSync(resolve(__dirname, '../fixtures/claude/context-usage.json'), 'utf8');

function answer(rawMaxTokens: unknown, requestId = WINDOW_REQUEST_ID, subtype = 'success'): string {
  const event = JSON.parse(REAL) as {
    response: { request_id: string; subtype: string; response: Record<string, unknown> };
  };
  event.response.request_id = requestId;
  event.response.subtype = subtype;
  event.response.response.rawMaxTokens = rawMaxTokens;
  return JSON.stringify(event);
}

describe('claudeWindowFromLine (W1, W6)', () => {
  it("reads the real answer's rawMaxTokens", () => {
    expect(claudeWindowFromLine(REAL.replace(/\s*\n\s*/g, ''), WINDOW_REQUEST_ID)).toBe(1_000_000);
  });

  it('ignores every other line', () => {
    expect(claudeWindowFromLine('not json', WINDOW_REQUEST_ID)).toBeUndefined();
    expect(claudeWindowFromLine('{"type":"system"}', WINDOW_REQUEST_ID)).toBeUndefined();
    // The initialize answer, or another request's answer.
    expect(claudeWindowFromLine(answer(200_000, 'magipilot-models'), WINDOW_REQUEST_ID)).toBe(
      undefined,
    );
  });

  it('gives null for the answer without a usable window', () => {
    expect(
      claudeWindowFromLine(answer(200_000, WINDOW_REQUEST_ID, 'error'), WINDOW_REQUEST_ID),
    ).toBe(null);
    for (const bad of [63_999, 2_000_001, 200_000.5, '200000', null, -1]) {
      expect(claudeWindowFromLine(answer(bad), WINDOW_REQUEST_ID), String(bad)).toBeNull();
    }
    // The bounds themselves count (P4CTX-R001).
    expect(claudeWindowFromLine(answer(64_000), WINDOW_REQUEST_ID)).toBe(64_000);
    expect(claudeWindowFromLine(answer(2_000_000), WINDOW_REQUEST_ID)).toBe(2_000_000);
  });
});

describe('sanitizeWindows (W2)', () => {
  it('keeps valid entries only, once each, at most 200', () => {
    const good: StoredWindow = { path: 'claude', model: 'opus', window: 1_000_000, at: 5 };
    expect(
      sanitizeWindows([
        good,
        { ...good },
        { ...good, model: 'bad model!' },
        { ...good, model: 'x', window: 1_000 },
        { ...good, model: 'y', at: -1 },
        { ...good, model: 'z', path: '' },
        'junk',
        null,
      ]),
    ).toEqual([good]);
    expect(sanitizeWindows('junk')).toEqual([]);
    const many = Array.from({ length: 250 }, (_, i) => ({ ...good, model: `m${i}` }));
    expect(sanitizeWindows(many)).toHaveLength(MAX_STORED_WINDOWS);
  });
});

/** A ClaudeWindows whose reads wait until `release` is called. */
function harness(
  options: {
    stored?: unknown;
    result?: (model: string) => number | DiscoveryFailure;
    assumed?: number;
  } = {},
) {
  let now = 1_000_000;
  const started: string[] = [];
  const waiting: (() => void)[] = [];
  const stored: StoredWindow[][] = [];
  const onChange = vi.fn();
  const log = vi.fn();
  const windows = new ClaudeWindows({
    read: (path, model) => {
      started.push(`${path}:${model}`);
      return new Promise((resolve) => {
        waiting.push(() => resolve(options.result?.(model) ?? 1_000_000));
      });
    },
    store: { get: () => options.stored, set: (value) => stored.push(value) },
    onChange,
    log,
    now: () => now,
    ...(options.assumed !== undefined ? { assumed: options.assumed } : {}),
  });
  const releaseAll = async (): Promise<void> => {
    while (waiting.length > 0) {
      waiting.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    windows,
    started,
    stored,
    onChange,
    log,
    releaseAll,
    running: () => waiting.length,
    /** Lets the oldest running read finish, the others still pending. */
    releaseOne: async (): Promise<void> => {
      waiting.shift()!();
      await new Promise((resolve) => setImmediate(resolve));
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ClaudeWindows (W2)', () => {
  it('reads two at a time, once per model, then reports one batch', async () => {
    const h = harness();
    h.windows.request('claude', ['opus', 'sonnet', 'haiku', 'opus']);
    h.windows.request('claude', ['opus']);
    expect(h.started).toEqual(['claude:opus', 'claude:sonnet']);
    expect(h.running()).toBe(2);
    await h.releaseAll();
    expect(h.started).toEqual(['claude:opus', 'claude:sonnet', 'claude:haiku']);
    expect(h.windows.window('claude', 'haiku')).toBe(1_000_000);
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledTimes(1);
    expect(h.log.mock.calls[0]![0]).toMatchObject({ asked: 3, windows: 3, failures: 0 });
    expect(
      h.stored
        .at(-1)!
        .map((entry) => entry.model)
        .sort(),
    ).toEqual(['haiku', 'opus', 'sonnet']);
  });

  it('uses a known window at once and reads it again only after a day', async () => {
    const h = harness();
    h.windows.request('claude', ['opus']);
    await h.releaseAll();
    h.advance(WINDOW_REFRESH_MS - 1);
    h.windows.request('claude', ['opus']);
    expect(h.started).toHaveLength(1);
    h.advance(1);
    h.windows.request('claude', ['opus']);
    expect(h.started).toHaveLength(2);
    // The stale value answers meanwhile.
    expect(h.windows.window('claude', 'opus')).toBe(1_000_000);
    await h.releaseAll();
    // Same window again: stored with the new time, but no change event.
    expect(h.onChange).toHaveBeenCalledTimes(1);
    expect(h.stored).toHaveLength(2);
  });

  it('reports a shrinking window at once, and growing ones at the end of the batch (P4PICK-I003, I004)', async () => {
    const results: Record<string, number> = { opus: 1_000_000, sonnet: 1_000_000 };
    const h = harness({ result: (model) => results[model] ?? 1_000_000, assumed: 200_000 });
    // First reads: 1M against the assumed 200K grows the budgets; one report, at the end.
    h.windows.request('claude', ['opus', 'sonnet']);
    await h.releaseAll();
    expect(h.onChange.mock.calls).toEqual([[false]]);
    // A day later Opus shrinks to 200K while Sonnet's read is still pending: reported at once.
    results.opus = 200_000;
    h.advance(WINDOW_REFRESH_MS);
    h.windows.request('claude', ['opus', 'sonnet']);
    await h.releaseOne();
    expect(h.onChange.mock.calls).toEqual([[false], [true]]);
    expect(h.windows.window('claude', 'opus')).toBe(200_000);
    await h.releaseAll();
    expect(h.onChange.mock.calls).toEqual([[false], [true], [false]]);
    // A first read below the assumed window shrinks too.
    results.small = 100_000;
    h.windows.request('claude', ['small']);
    await h.releaseOne();
    expect(h.onChange.mock.calls.at(-2)).toEqual([true]);
  });

  it('does not repeat a failed read for 10 minutes', async () => {
    const h = harness({ result: () => 'timeout' });
    h.windows.request('claude', ['opus']);
    await h.releaseAll();
    expect(h.windows.window('claude', 'opus')).toBeUndefined();
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.stored).toHaveLength(0);
    expect(h.log.mock.calls[0]![0]).toMatchObject({ asked: 1, windows: 0, failures: 1 });
    h.advance(WINDOW_RETRY_MS - 1);
    h.windows.request('claude', ['opus']);
    expect(h.started).toHaveLength(1);
    h.advance(1);
    h.windows.request('claude', ['opus']);
    expect(h.started).toHaveLength(2);
  });

  it('treats a window outside the bounds as a failure', async () => {
    const h = harness({ result: () => 63_999 });
    h.windows.request('claude', ['opus']);
    await h.releaseAll();
    expect(h.windows.window('claude', 'opus')).toBeUndefined();
  });

  it('keeps windows per path, and skips ids that cannot be a model', async () => {
    const h = harness({ result: (model) => (model === 'claude-opus-4-6' ? 200_000 : 1_000_000) });
    h.windows.request('/a/claude', ['opus', 'bad id!']);
    h.windows.request('/b/claude', ['claude-opus-4-6']);
    await h.releaseAll();
    expect(h.started).toEqual(['/a/claude:opus', '/b/claude:claude-opus-4-6']);
    expect(h.windows.window('/a/claude', 'opus')).toBe(1_000_000);
    expect(h.windows.window('/b/claude', 'opus')).toBeUndefined();
    expect(h.windows.window('/b/claude', 'claude-opus-4-6')).toBe(200_000);
  });

  it('starts from the store, checked again', () => {
    const h = harness({
      stored: [
        { path: 'claude', model: 'opus', window: 1_000_000, at: 1_000_000 },
        { path: 'claude', model: 'sonnet', window: 5, at: 1_000_000 },
      ],
    });
    expect(h.windows.window('claude', 'opus')).toBe(1_000_000);
    expect(h.windows.window('claude', 'sonnet')).toBeUndefined();
    // A fresh stored window is not read again.
    h.windows.request('claude', ['opus']);
    expect(h.started).toEqual([]);
  });

  it('drops the queued reads when settings change, and reads them again on request (P4CTX-I001)', async () => {
    const h = harness();
    h.windows.request('claude', ['opus', 'sonnet', 'haiku', 'fable']);
    expect(h.running()).toBe(2);
    // Discovery turned off (or the path changed): nothing queued may start.
    h.windows.invalidate();
    await h.releaseAll();
    expect(h.started).toEqual(['claude:opus', 'claude:sonnet']);
    // The running reads are kept: they belong to their own path and model.
    expect(h.windows.window('claude', 'opus')).toBe(1_000_000);
    expect(h.windows.window('claude', 'haiku')).toBeUndefined();
    // Allowed again: the dropped ones are queued anew, the read ones are not.
    h.windows.request('claude', ['opus', 'sonnet', 'haiku', 'fable']);
    expect(h.started).toEqual(['claude:opus', 'claude:sonnet', 'claude:haiku', 'claude:fable']);
    await h.releaseAll();
  });

  it('settles once no read runs', async () => {
    const h = harness();
    await h.windows.settle();
    h.windows.request('claude', ['opus', 'sonnet', 'haiku']);
    h.windows.invalidate();
    let settled = false;
    const done = h.windows.settle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    await h.releaseAll();
    await done;
    expect(settled).toBe(true);
    expect(h.started).toHaveLength(2);
  });

  it('starts nothing after dispose, and drops what running reads bring', async () => {
    const h = harness();
    h.windows.request('claude', ['opus', 'sonnet', 'haiku']);
    h.windows.dispose();
    await h.releaseAll();
    expect(h.started).toHaveLength(2);
    expect(h.onChange).not.toHaveBeenCalled();
    expect(h.stored).toHaveLength(0);
    h.windows.request('claude', ['fable']);
    expect(h.started).toHaveLength(2);
  });
});
