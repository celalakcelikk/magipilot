import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeStreamReader, totalInputTokens } from '../../src/core/process/claudeStream';
import { CodexJsonlReader } from '../../src/core/process/codexJsonl';

const FIXTURES = join(__dirname, '..', 'fixtures');

function lines(relPath: string): string[] {
  return readFileSync(join(FIXTURES, relPath), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

describe('ClaudeStreamReader on real captures (Claude Code 2.1.310)', () => {
  it('reads init, partial text and the result of a single -p run', () => {
    const reader = new ClaudeStreamReader();
    const completed = lines('claude/stream-json-basic.jsonl').map((l, i) =>
      reader.push(l, 1000 + i),
    );
    expect(reader.parseErrors).toBe(0);
    expect(reader.init?.model).toBe('claude-haiku-5-5');
    expect(reader.init?.toolsCount).toBe(0);
    expect(reader.init?.mcpServersCount).toBe(0);
    expect(reader.turns).toHaveLength(1);
    expect(completed.filter(Boolean)).toHaveLength(1);
    const [turn] = reader.turns;
    expect(turn?.text).toBe('OK');
    expect(turn?.isError).toBe(false);
    expect(turn?.resultSubtype).toBe('success');
    expect(turn?.toolUseSeen).toBe(false);
    expect(turn?.serverTtftMs).toBeGreaterThan(0);
    expect(turn?.firstTextAt).toBeDefined();
    expect(turn?.completedAt).toBeGreaterThanOrEqual(turn!.firstTextAt!);
    expect(totalInputTokens(turn!.usage!)).toBeGreaterThan(0);
  });

  it('splits a stream-json input session into turns', () => {
    const reader = new ClaudeStreamReader();
    lines('claude/stream-json-session.jsonl').forEach((l, i) => reader.push(l, i));
    expect(reader.turns.map((t) => t.text)).toEqual(['OK', 'OK']);
    expect(reader.turns.every((t) => !t.isError)).toBe(true);
    // Context grows: the second turn sees more input tokens than the first.
    const [first, second] = reader.turns.map((t) => totalInputTokens(t.usage!));
    expect(second).toBeGreaterThan(first!);
  });

  it('counts unparsable lines and flags tool use', () => {
    const reader = new ClaudeStreamReader();
    reader.push('not json', 0);
    reader.push(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } },
      }),
      1,
    );
    reader.push(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
      2,
    );
    expect(reader.parseErrors).toBe(1);
    expect(reader.turns[0]).toMatchObject({ toolUseSeen: true, isError: true, text: '' });
  });

  it('falls back to the assistant message when no partial deltas were emitted', () => {
    const reader = new ClaudeStreamReader();
    reader.push(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x + y' }] },
      }),
      5,
    );
    const turn = reader.push(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false }),
      6,
    );
    expect(turn).toMatchObject({ text: 'x + y', firstTextAt: 5, completedAt: 6, isError: false });
  });
});

describe('CodexJsonlReader on a real capture (codex-cli 0.164.0)', () => {
  it('extracts the final agent message and usage', () => {
    const reader = new CodexJsonlReader();
    lines('codex/exec-json-basic.jsonl').forEach((l, i) => reader.push(l, 100 + i));
    expect(reader.parseErrors).toBe(0);
    expect(reader.threadId).toBeTruthy();
    expect(reader.text).toBe('OK');
    expect(reader.failed).toBe(false);
    expect(reader.usage?.inputTokens).toBeGreaterThan(0);
    expect(reader.firstMessageAt).toBeDefined();
    // Captured with the production profile (--ignore-user-config): no configuration warnings.
    expect(reader.warningCount).toBe(0);
    expect(reader.errorCount).toBe(0);
    expect(reader.failureKind).toBeUndefined();
  });

  it('collects `error` items (e.g. configuration warnings) without failing the turn', () => {
    const reader = new CodexJsonlReader();
    reader.push(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'error', message: 'Codex is ignoring 1 unrecognized setting.' },
      }),
      1,
    );
    reader.push(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }),
      2,
    );
    expect(reader.warningCount).toBe(1);
    expect(reader.errorCount).toBe(0);
    expect(reader.failed).toBe(false);
    expect(reader.text).toBe('OK');
  });

  it('marks failed turns', () => {
    const reader = new CodexJsonlReader();
    reader.push(
      JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }),
      1,
    );
    expect(reader.failed).toBe(true);
    expect(reader.errorCount).toBe(1);
    // Only the kind is kept, never the message (phase-3-errors §3 step 2).
    expect(reader.failureKind).toBe('limit');
  });
});
