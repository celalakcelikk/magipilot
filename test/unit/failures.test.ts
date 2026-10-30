// Classified CLI failures (docs/plans/phase-3-errors.md): the readers on the real auth-failure
// captures, every phrase from the CLI binaries, the precedence, the fixed messages and the inline
// cool-down.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyClaudeResult,
  classifyCodexMessage,
  CliFailure,
  failureKind,
  failureMessage,
  isCliFailure,
  type CliFailureKind,
} from '../../src/core/backends/failures';
import { ClaudeStreamReader } from '../../src/core/process/claudeStream';
import { CodexJsonlReader } from '../../src/core/process/codexJsonl';
import { COOLDOWN_MS, Cooldowns, unavailableMessage } from '../../src/features/inline/rules';

const lines = (path: string): string[] =>
  readFileSync(join(__dirname, '..', 'fixtures', path), 'utf8')
    .split('\n')
    .filter(Boolean);

describe('the readers on the real auth-failure captures (AC1, AC2)', () => {
  it('Claude Code 2.1.312, --bare with an invalid key: api_error_status 401 → not-logged-in', () => {
    const reader = new ClaudeStreamReader();
    lines('claude/auth-failure.jsonl').forEach((line, i) => reader.push(line, i));
    const turn = reader.turns.at(-1);
    expect(turn?.isError).toBe(true);
    expect(turn?.failureKind).toBe('not-logged-in');
    // The result text is not kept anywhere on the turn.
    expect(JSON.stringify(turn)).not.toMatch(/invalid api key/i);
  });

  it('codex-cli 0.164.0, empty CODEX_HOME: 401 Unauthorized → not-logged-in; retries are warnings', () => {
    const reader = new CodexJsonlReader();
    lines('codex/auth-failure.jsonl').forEach((line, i) => reader.push(line, i));
    expect(reader.failed).toBe(true);
    expect(reader.failureKind).toBe('not-logged-in');
    expect(reader.errorCount).toBe(2);
    expect(reader.warningCount).toBeGreaterThan(0);
    expect(JSON.stringify(reader)).not.toMatch(/unauthorized|bearer/i);
  });

  it('a Codex retry alone does not fail the turn', () => {
    const reader = new CodexJsonlReader();
    reader.push(
      JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (stream error)' }),
      1,
    );
    reader.push(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }),
      2,
    );
    reader.push(JSON.stringify({ type: 'turn.completed', usage: {} }), 3);
    expect(reader.failed).toBe(false);
    expect(reader.warningCount).toBe(1);
    expect(reader.text).toBe('OK');
  });
});

describe('Claude classification (fields and phrases from the 2.1.312 binary, unverified)', () => {
  it.each([
    [{ apiErrorStatus: 401 }, 'not-logged-in'],
    [{ apiErrorStatus: 403 }, 'not-logged-in'],
    [{ apiErrorStatus: 429 }, 'limit'],
    [{ rateLimitRejected: true }, 'limit'],
    [{ text: 'Not logged in · Please run /login' }, 'not-logged-in'],
    [{ text: 'OAuth token revoked · Please run /login' }, 'not-logged-in'],
    [{ text: 'OAuth token has expired' }, 'not-logged-in'],
    [
      { text: 'OAuth refresh token is no longer valid; run /login to re-authenticate' },
      'not-logged-in',
    ],
    [{ text: 'Invalid API key · Fix external API key' }, 'not-logged-in'],
    [{ text: "You've hit your limit · resets 5pm" }, 'limit'],
    [{ text: 'You’ve hit your usage limit' }, 'limit'],
    [{ text: 'Claude AI usage limit reached|1793090400' }, 'limit'],
    [{ text: 'Credit balance is too low' }, 'limit'],
    [{ text: 'Prompt is too long' }, 'context'],
    [
      { apiErrorStatus: 400, text: 'Prompt is too long: 250000 tokens > 200000 maximum' },
      'context',
    ],
    [{ text: 'input is too long for requested model' }, 'context'],
    [{ text: 'The model has reached its context window limit.' }, 'context'],
    [{ text: 'Something else went wrong' }, 'other'],
    [{}, 'other'],
  ] as const)('%o → %s', (fields, kind) => {
    expect(classifyClaudeResult(fields)).toBe(kind);
  });

  it('a rejected window or overage alone is not a limit: only the top-level status counts', () => {
    const reader = new ClaudeStreamReader();
    // As in the normal captures: allowed at the top, overage rejected.
    reader.push(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', overageStatus: 'rejected' },
      }),
      1,
    );
    reader.push(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      2,
    );
    expect(reader.turns.at(-1)?.failureKind).toBe('other');
    const rejected = new ClaudeStreamReader();
    rejected.push(
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }),
      1,
    );
    rejected.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: true }), 2);
    expect(rejected.turns.at(-1)?.failureKind).toBe('limit');
  });

  it('no CLI text leaves the reader: subtype, result and synthetic text (inspection P3E-I002)', () => {
    const MARKER = 'PROMPT_ECHO_9c2e';
    const reader = new ClaudeStreamReader();
    reader.push(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: MARKER }] } }),
      1,
    );
    reader.push(
      JSON.stringify({ type: 'result', subtype: MARKER, is_error: true, result: MARKER }),
      2,
    );
    const turn = reader.turns.at(-1);
    expect(turn?.resultSubtype).toBe('other');
    expect(turn?.failureKind).toBe('other');
    expect(JSON.stringify(reader.turns)).not.toContain(MARKER);
    // Known subtypes pass through unchanged.
    const known = new ClaudeStreamReader();
    known.push(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }), 1);
    expect(known.turns.at(-1)?.resultSubtype).toBe('error_max_turns');
  });

  it('a successful turn has no failure kind', () => {
    const reader = new ClaudeStreamReader();
    reader.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }), 1);
    expect(reader.turns.at(-1)?.failureKind).toBeUndefined();
  });
});

describe('Codex classification (phrases from the 0.164.0 binary, unverified)', () => {
  it.each([
    ['unexpected status 401 Unauthorized: Missing bearer', 'not-logged-in'],
    ['Not logged in', 'not-logged-in'],
    ['You’ve hit your usage limit. Upgrade to Plus to continue using Codex', 'limit'],
    ["You've reached your usage limit. Increase your limits to continue using codex.", 'limit'],
    ['Usage limit reached.', 'limit'],
    ['unexpected status 429 Too Many Requests', 'limit'],
    [
      "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      'context',
    ],
    ['context window exceeded', 'context'],
    ['stream disconnected before completion', undefined],
  ] as const)('%s → %s', (text, kind) => {
    expect(classifyCodexMessage(text)).toBe(kind);
  });
});

describe('precedence (phase-3-errors §3 step 3, E6)', () => {
  const base = { timedOut: false, processFailed: false, readerFailed: false, hasResult: true };
  it('a timeout wins', () => {
    expect(failureKind({ ...base, timedOut: true, processFailed: true, readerKind: 'limit' })).toBe(
      'timeout',
    );
  });
  it('a classified not-logged-in, limit or context wins over a non-zero exit', () => {
    for (const kind of ['not-logged-in', 'limit', 'context'] as const) {
      expect(
        failureKind({ ...base, processFailed: true, readerKind: kind, readerFailed: true }),
      ).toBe(kind);
    }
  });
  it('a non-zero exit after a successful turn, an unmatched failure or no result is other', () => {
    expect(failureKind({ ...base, processFailed: true })).toBe('other');
    expect(failureKind({ ...base, readerFailed: true, readerKind: 'other' })).toBe('other');
    expect(failureKind({ ...base, hasResult: false })).toBe('other');
  });
  it('success is undefined', () => {
    expect(failureKind(base)).toBeUndefined();
  });
});

describe('messages (phase-3-errors §4)', () => {
  const kinds: CliFailureKind[] = [
    'not-installed',
    'not-logged-in',
    'limit',
    'context',
    'timeout',
    'cancelled',
    'other',
  ];

  it('every kind has a fixed message that names the CLI and what to do', () => {
    expect(failureMessage('claude', 'not-installed')).toContain('magipilot.claude.path');
    expect(failureMessage('codex', 'not-installed')).toContain('magipilot.codex.path');
    expect(failureMessage('claude', 'not-logged-in')).toContain('Run `claude`');
    expect(failureMessage('codex', 'not-logged-in')).toContain('codex login');
    expect(failureMessage('claude', 'limit')).toContain('switch the backend');
    expect(failureMessage('claude', 'context')).toBe(
      'The conversation is too long for the Claude Code CLI. Start a new chat, or attach less.',
    );
    // An overflow is about one conversation, not the CLI: inline completion does not pause.
    expect(COOLDOWN_MS.context).toBeUndefined();
    for (const kind of kinds) {
      expect(new CliFailure('claude', kind).message).toBe(failureMessage('claude', kind));
    }
  });

  it('a CliFailure never carries input text: its message depends on the CLI and kind only', () => {
    const failure = new CliFailure('codex', 'other', 'exit 1');
    expect(failure.message).toBe(failureMessage('codex', 'other'));
    expect(failure.kind).toBe('other');
    expect(failure.detail).toBe('exit 1');
  });

  it('isCliFailure recognises a failure by its shape, also from another bundle', () => {
    expect(isCliFailure(new CliFailure('claude', 'limit'))).toBe(true);
    const foreign = Object.assign(new Error('x'), {
      name: 'CliFailure',
      cli: 'codex',
      kind: 'other',
    });
    expect(isCliFailure(foreign)).toBe(true);
    expect(
      isCliFailure(
        Object.assign(new Error('x'), { name: 'CliFailure', cli: 'codex', kind: 'nope' }),
      ),
    ).toBe(false);
    expect(isCliFailure(new Error('Claude CLI exit 1'))).toBe(false);
    expect(isCliFailure('CliFailure')).toBe(false);
  });

  it('unavailable backends: the CLIs by their path setting, the HTTP backends as before', () => {
    expect(unavailableMessage('claude-cli')).toBe(failureMessage('claude', 'not-installed'));
    expect(unavailableMessage('codex-cli')).toBe(failureMessage('codex', 'not-installed'));
    expect(unavailableMessage('ollama')).toMatch(/^not available/);
  });
});

describe('Cooldowns (AC4)', () => {
  it('starts after not-logged-in (60 s) and limit (5 min), not after other kinds', () => {
    let now = 0;
    const cooldowns = new Cooldowns(() => now);
    cooldowns.start('claude-cli', 'not-logged-in');
    cooldowns.start('codex-cli', 'limit');
    cooldowns.start('ollama', 'other');
    expect(cooldowns.active('claude-cli')).toBe(true);
    expect(cooldowns.active('codex-cli')).toBe(true);
    expect(cooldowns.active('ollama')).toBe(false);
    now = COOLDOWN_MS['not-logged-in']!;
    expect(cooldowns.active('claude-cli')).toBe(false);
    expect(cooldowns.active('codex-cli')).toBe(true);
    now = COOLDOWN_MS.limit!;
    expect(cooldowns.active('codex-cli')).toBe(false);
  });

  it('clear() ends every cool-down (a settings change, the manual trigger)', () => {
    const cooldowns = new Cooldowns(() => 0);
    cooldowns.start('claude-cli', 'limit');
    cooldowns.clear();
    expect(cooldowns.active('claude-cli')).toBe(false);
  });
});
