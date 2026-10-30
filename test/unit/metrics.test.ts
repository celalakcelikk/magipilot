import { describe, expect, it } from 'vitest';
import { ChatStats, Metrics } from '../../src/metrics';

describe('Metrics', () => {
  it('counts backend outcomes and latency percentiles per backend', () => {
    const metrics = new Metrics();
    for (const ms of [100, 200, 300, 400]) metrics.recordRequest('claude-cli', 'completion', ms);
    metrics.recordRequest('claude-cli', 'empty', 50);
    metrics.recordRequest('claude-cli', 'error', 9999);
    metrics.recordRequest('claude-cli', 'cancelled', 8888);
    expect(metrics.snapshot()['claude-cli']).toEqual({
      requests: 7,
      completions: 4,
      empty: 1,
      errors: 1,
      cancelled: 1,
      p50Ms: 200,
      p95Ms: 400,
      shown: 0,
      cacheHits: 0,
      accepted: 0,
      acceptanceRate: undefined,
      timeToSuggestionP50Ms: undefined,
    });
  });

  it('counts suggestions shown from the backend and the cache apart from backend requests', () => {
    const metrics = new Metrics();
    metrics.recordRequest('ollama', 'completion', 120);
    metrics.recordShown('ollama', { fromCache: false, ms: 330 });
    metrics.recordShown('ollama', { fromCache: true, ms: 5 });
    metrics.recordShown('ollama', { fromCache: true, ms: 7 });
    metrics.recordAccepted('ollama');
    const stats = metrics.snapshot().ollama!;
    expect(stats).toMatchObject({
      requests: 1,
      completions: 1,
      shown: 3,
      cacheHits: 2,
      accepted: 1,
    });
    expect(stats.acceptanceRate).toBeCloseTo(1 / 3);
    expect(stats.timeToSuggestionP50Ms).toBe(7);
  });

  it('keeps the acceptance rate at most 100 % when a cached suggestion is accepted again and again (METRICS-002)', () => {
    const metrics = new Metrics();
    metrics.recordRequest('ollama', 'completion', 100);
    metrics.recordShown('ollama', { fromCache: false, ms: 300 });
    metrics.recordAccepted('ollama');
    for (let i = 0; i < 5; i++) {
      // Typing through the shown suggestion: each step is a cache hit returned to VS Code.
      metrics.recordShown('ollama', { fromCache: true, ms: 3 });
      metrics.recordAccepted('ollama');
    }
    const stats = metrics.snapshot().ollama!;
    expect(stats.shown).toBe(6);
    expect(stats.accepted).toBe(6);
    expect(stats.acceptanceRate).toBe(1);
    // An acceptance without a recorded impression is still capped.
    metrics.recordAccepted('ollama');
    expect(metrics.snapshot().ollama!.acceptanceRate).toBe(1);
  });

  it('keeps at most 500 latency samples', () => {
    const metrics = new Metrics();
    for (let i = 0; i < 500; i++) metrics.recordRequest('ollama', 'completion', 10_000);
    for (let i = 0; i < 500; i++) metrics.recordRequest('ollama', 'completion', 1);
    expect(metrics.snapshot().ollama!.p95Ms).toBe(1);
    expect(metrics.snapshot().ollama!.requests).toBe(1000);
  });

  it('reset() clears every backend', () => {
    const metrics = new Metrics();
    metrics.recordRequest('ollama', 'completion', 100);
    metrics.recordShown('ollama', { fromCache: false, ms: 300 });
    metrics.reset();
    expect(metrics.snapshot()).toEqual({});
  });
});

describe('ChatStats (METRICS-003)', () => {
  it('counts outcomes per model beyond the 200-record history', () => {
    const chat = new ChatStats();
    for (let i = 0; i < 250; i++) chat.record('claude-cli.haiku', 'complete', 1000 + i);
    chat.record('claude-cli.haiku', 'cancelled', 10);
    chat.record('codex-cli.default', 'error', 20);
    for (let i = 0; i < 300; i++) chat.record('codex-cli.default', 'complete', 3000);
    const stats = chat.snapshot();
    expect(stats['claude-cli.haiku']).toMatchObject({
      requests: 251,
      complete: 250,
      cancelled: 1,
      errors: 0,
    });
    expect(stats['codex-cli.default']).toMatchObject({
      requests: 301,
      complete: 300,
      errors: 1,
      p50Ms: 3000,
    });
  });

  it('reset() clears every model', () => {
    const chat = new ChatStats();
    chat.record('claude-cli.haiku', 'complete', 100);
    chat.reset();
    expect(chat.snapshot()).toEqual({});
  });
});
