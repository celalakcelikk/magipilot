// Structured answers for tool calling (docs/plans/phase-4-tools.md T2, T3). A chat-only capability
// next to the frozen `Backend` interface: the CLI chat backends implement it, the FIM backends do
// not. The CLI fills one fixed envelope; the provider turns it into VS Code tool call parts and
// never runs anything itself (AGENTS.md rules 2, 3).
import type { Backend, RunOptions } from './types';

/** One requested tool call, as the model wrote it: `arguments` is a JSON-encoded object. */
export interface ToolCallRequest {
  name: string;
  arguments: string;
}

export interface StructuredAnswer {
  message: string;
  toolCalls: ToolCallRequest[];
}

/**
 * The answer envelope for both CLIs (T2). Every property is required and no other is allowed;
 * `arguments` is a string because Codex's strict output schema cannot express a free-form object.
 */
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'tool_calls'],
  properties: {
    message: { type: 'string' },
    tool_calls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'arguments'],
        properties: { name: { type: 'string' }, arguments: { type: 'string' } },
      },
    },
  },
} as const;

export interface StructuredChatBackend {
  /** One turn with the answer envelope; rejects on a CLI failure or an answer that is not one. */
  runStructured(prompt: string, opts: RunOptions): Promise<StructuredAnswer>;
}

export function isStructuredChatBackend(
  backend: Backend,
): backend is Backend & StructuredChatBackend {
  return typeof (backend as Partial<StructuredChatBackend>).runStructured === 'function';
}

export type InvalidAnswerReason =
  'not-json' | 'not-envelope' | 'unknown-tool' | 'bad-arguments' | 'no-call';

const REASON_TEXT: Record<InvalidAnswerReason, string> = {
  'not-json': 'the answer is not JSON',
  'not-envelope': 'the answer is not the tool-call envelope',
  'unknown-tool': 'it called a tool the request did not offer',
  'bad-arguments': 'tool arguments were not a JSON object',
  'no-call': 'the request required a tool call and it made none',
};

/** An answer that cannot be used. Its message is fixed: the answer is never quoted (C6, T7). */
export class InvalidAnswerError extends Error {
  constructor(readonly reason: InvalidAnswerReason) {
    super(REASON_TEXT[reason]);
    this.name = 'InvalidAnswerError';
  }
}

export interface ValidToolCall {
  name: string;
  input: object;
}

/**
 * The answer's calls, all checked or none (T7): every name must be one the request offered, every
 * `arguments` a JSON object, and `required` needs at least one call. Input schemas are not checked
 * here: Copilot validates tool input and reports its errors as tool results.
 */
export function validateToolCalls(
  answer: StructuredAnswer,
  offered: ReadonlySet<string>,
  required: boolean,
): ValidToolCall[] {
  const calls: ValidToolCall[] = [];
  for (const call of answer.toolCalls) {
    if (!offered.has(call.name)) throw new InvalidAnswerError('unknown-tool');
    let input: unknown;
    try {
      input = JSON.parse(call.arguments);
    } catch {
      throw new InvalidAnswerError('bad-arguments');
    }
    if (!isRecord(input)) throw new InvalidAnswerError('bad-arguments');
    calls.push({ name: call.name, input });
  }
  if (required && calls.length === 0) throw new InvalidAnswerError('no-call');
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the envelope from an object (Claude's `structured_output`) or its JSON text (Codex's last
 * message). Only the shape is checked here; names and arguments are the provider's (T7).
 */
export function parseEnvelope(raw: unknown): StructuredAnswer {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new InvalidAnswerError('not-json');
    }
  }
  if (!isRecord(value) || typeof value.message !== 'string' || !Array.isArray(value.tool_calls)) {
    throw new InvalidAnswerError('not-envelope');
  }
  const toolCalls: ToolCallRequest[] = [];
  for (const call of value.tool_calls) {
    if (!isRecord(call) || typeof call.name !== 'string' || typeof call.arguments !== 'string') {
      throw new InvalidAnswerError('not-envelope');
    }
    toolCalls.push({ name: call.name, arguments: call.arguments });
  }
  return { message: value.message, toolCalls };
}
