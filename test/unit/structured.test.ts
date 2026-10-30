import { describe, expect, it } from 'vitest';
import {
  ANSWER_SCHEMA,
  InvalidAnswerError,
  isStructuredChatBackend,
  parseEnvelope,
  validateToolCalls,
  type StructuredAnswer,
} from '../../src/core/backends/structured';
import type { Backend } from '../../src/core/backends/types';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs, buildCodexArgs } from '../../src/core/process/cliArgs';
import { ClaudeStreamReader } from '../../src/core/process/claudeStream';
import { CodexJsonlReader } from '../../src/core/process/codexJsonl';

const reason = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof InvalidAnswerError ? err.reason : `other: ${String(err)}`;
  }
  return undefined;
};

describe('parseEnvelope (phase-4-tools.md T2)', () => {
  it('reads an object (Claude structured_output) and its JSON text (Codex last message)', () => {
    const value = {
      message: '',
      tool_calls: [{ name: 'read_file', arguments: '{"path":"README.md"}' }],
    };
    const expected: StructuredAnswer = {
      message: '',
      toolCalls: [{ name: 'read_file', arguments: '{"path":"README.md"}' }],
    };
    expect(parseEnvelope(value)).toEqual(expected);
    expect(parseEnvelope(JSON.stringify(value))).toEqual(expected);
  });

  it('rejects what is not the envelope, without quoting it', () => {
    expect(reason(() => parseEnvelope('not json {'))).toBe('not-json');
    expect(reason(() => parseEnvelope(undefined))).toBe('not-envelope');
    expect(reason(() => parseEnvelope({ message: 'hi' }))).toBe('not-envelope');
    expect(reason(() => parseEnvelope({ message: 1, tool_calls: [] }))).toBe('not-envelope');
    expect(
      reason(() => parseEnvelope({ message: '', tool_calls: [{ name: 'x', arguments: {} }] })),
    ).toBe('not-envelope');
    expect(reason(() => parseEnvelope('[]'))).toBe('not-envelope');
    const err = (() => {
      try {
        parseEnvelope('SECRET-TEXT');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain('SECRET');
  });
});

describe('validateToolCalls (T7)', () => {
  const offered = new Set(['read_file', 'grep']);
  const answer = (...calls: [string, string][]): StructuredAnswer => ({
    message: 'm',
    toolCalls: calls.map(([name, args]) => ({ name, arguments: args })),
  });

  it('parses every call into an input object', () => {
    expect(
      validateToolCalls(answer(['read_file', '{"path":"a"}'], ['grep', '{}']), offered, false),
    ).toEqual([
      { name: 'read_file', input: { path: 'a' } },
      { name: 'grep', input: {} },
    ]);
    expect(validateToolCalls(answer(), offered, false)).toEqual([]);
  });

  it('fails the whole answer for one bad call', () => {
    expect(
      reason(() => validateToolCalls(answer(['read_file', '{}'], ['rm', '{}']), offered, false)),
    ).toBe('unknown-tool');
    expect(reason(() => validateToolCalls(answer(['read_file', 'nope']), offered, false))).toBe(
      'bad-arguments',
    );
    expect(reason(() => validateToolCalls(answer(['read_file', '']), offered, false))).toBe(
      'bad-arguments',
    );
    expect(reason(() => validateToolCalls(answer(['read_file', '[1]']), offered, false))).toBe(
      'bad-arguments',
    );
    expect(reason(() => validateToolCalls(answer(['read_file', '"x"']), offered, false))).toBe(
      'bad-arguments',
    );
  });

  it('requires a call under toolMode Required', () => {
    expect(reason(() => validateToolCalls(answer(), offered, true))).toBe('no-call');
    expect(validateToolCalls(answer(['grep', '{}']), offered, true)).toHaveLength(1);
  });
});

describe('the structured capability (T3)', () => {
  it('is detected by its method, not by the backend id', () => {
    const plain = { id: 'ollama', kind: 'fim' } as unknown as Backend;
    const structured = { ...plain, runStructured: () => Promise.resolve() } as unknown as Backend;
    expect(isStructuredChatBackend(plain)).toBe(false);
    expect(isStructuredChatBackend(structured)).toBe(true);
  });
});

describe('the CLI flags (T2)', () => {
  it('adds --json-schema to Claude and keeps the isolation', () => {
    const args = buildClaudeArgs({
      model: 'haiku',
      systemPrompt: 'S',
      jsonSchema: JSON.stringify(ANSWER_SCHEMA),
    });
    expect(args.slice(args.indexOf('--json-schema'), args.indexOf('--json-schema') + 2)).toEqual([
      '--json-schema',
      JSON.stringify(ANSWER_SCHEMA),
    ]);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
      '--tools',
      '',
    ]);
    expect(args).toContain('--safe-mode');
    expect(buildClaudeArgs({ model: 'haiku', systemPrompt: 'S' })).not.toContain('--json-schema');
  });

  it('adds --output-schema to Codex before the prompt marker', () => {
    const args = buildCodexArgs({
      model: 'm',
      effort: 'low',
      cwd: '/tmp/a',
      lastMessagePath: '/tmp/b/last.txt',
      outputSchemaPath: '/tmp/b/schema.json',
    });
    expect(args).toContain('read-only');
    expect(args.indexOf('--output-schema')).toBeGreaterThan(-1);
    expect(args[args.indexOf('--output-schema') + 1]).toBe('/tmp/b/schema.json');
    expect(args.at(-1)).toBe('-');
    expect(
      buildCodexArgs({ model: 'm', effort: 'low', cwd: '/a', lastMessagePath: '/b' }),
    ).not.toContain('--output-schema');
  });

  it('has a schema Codex accepts in strict mode: every property required, nothing else allowed', () => {
    expect(ANSWER_SCHEMA.additionalProperties).toBe(false);
    expect([...ANSWER_SCHEMA.required].sort()).toEqual(
      Object.keys(ANSWER_SCHEMA.properties).sort(),
    );
    const item = ANSWER_SCHEMA.properties.tool_calls.items;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(Object.keys(item.properties).sort());
  });
});

describe('real structured output (cli-verify S1 fixtures, T9)', () => {
  const lines = (path: string): string[] =>
    readFileSync(join(__dirname, '..', 'fixtures', path), 'utf8')
      .split('\n')
      .filter(Boolean);

  it('reads Claude Code 2.1.312 --json-schema output: one internal tool, the envelope as result', () => {
    const reader = new ClaudeStreamReader();
    lines('claude/structured-tool-call.jsonl').forEach((line, i) => reader.push(line, i));
    expect(reader.init?.toolsCount).toBe(1);
    expect(reader.init?.mcpServersCount).toBe(0);
    const turn = reader.turns.at(-1)!;
    expect(turn.isError).toBe(false);
    expect(turn.text).toBe('');
    const answer = parseEnvelope(turn.structuredOutput);
    expect(answer.toolCalls.map((call) => call.name)).toEqual(['read_file']);
    expect(validateToolCalls(answer, new Set(['read_file']), true)).toEqual([
      { name: 'read_file', input: { path: 'README.md' } },
    ]);
  });

  it('reads codex-cli 0.164.0 --output-schema output: the last agent message is the envelope', () => {
    const reader = new CodexJsonlReader();
    lines('codex/structured-tool-call.jsonl').forEach((line, i) => reader.push(line, i));
    expect(reader.failed).toBe(false);
    // Codex wrote a plain-text preamble message first; only the last message counts.
    const answer = parseEnvelope(reader.text);
    expect(validateToolCalls(answer, new Set(['read_file']), false)).toEqual([
      { name: 'read_file', input: { path: 'README.md' } },
    ]);
  });

  it('keeps no structured output from a failed Claude turn', () => {
    const reader = new ClaudeStreamReader();
    reader.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_structured_output_retries',
        is_error: true,
        structured_output: { message: 'x', tool_calls: [] },
      }),
      0,
    );
    expect(reader.turns[0]!.structuredOutput).toBeUndefined();
    expect(reader.turns[0]!.resultSubtype).toBe('error_max_structured_output_retries');
  });
});
