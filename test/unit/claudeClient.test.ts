import { describe, expect, it } from 'vitest';
import { classifyProcessAttempt } from '../../scripts/bench/clients/claude';
import type { CompletionAttempt } from '../../scripts/bench/clients/types';
import type { ProcessResult } from '../../src/core/process/runner';

const success: CompletionAttempt = { ok: true, text: 'return x', totalMs: 900 };
const cleanExit: ProcessResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stderrTail: '',
};

describe('classifyProcessAttempt (review P0-R2-001)', () => {
  it('keeps a successful result when the process exits cleanly', () => {
    expect(classifyProcessAttempt(success, cleanExit)).toEqual(success);
  });

  it('fails a result followed by a timeout, keeping the text for diagnosis', () => {
    const attempt = classifyProcessAttempt(success, {
      ...cleanExit,
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toContain('timeout');
    expect(attempt.text).toBe('return x');
  });

  it('fails a result followed by a non-zero exit', () => {
    const attempt = classifyProcessAttempt(success, {
      ...cleanExit,
      exitCode: 1,
      stderrTail: 'Error: something broke\nmore',
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toBe('exit 1: Error: something broke (after a result event)');
  });

  it('fails a result followed by a kill (grace period exceeded)', () => {
    const attempt = classifyProcessAttempt(success, {
      ...cleanExit,
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(attempt.ok).toBe(false);
    expect(attempt.error).toContain('SIGTERM');
  });

  it('keeps the original error of an attempt that already failed', () => {
    const attempt = classifyProcessAttempt(
      { ok: false, text: '', error: 'no result event' },
      { ...cleanExit, aborted: true, exitCode: null, signal: 'SIGTERM' },
    );
    expect(attempt).toMatchObject({ ok: false, error: 'aborted; no result event' });
  });
});
