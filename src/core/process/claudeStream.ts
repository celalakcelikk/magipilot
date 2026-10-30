// Incremental reader for `claude -p --output-format stream-json --verbose` output.
// Event shapes are taken from real captures in test/fixtures/claude/.

import { classifyClaudeResult, type CliFailureKind } from '../backends/failures';

export interface ClaudeUsage {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export interface ClaudeTurn {
  /** Concatenated assistant text of this turn. */
  text: string;
  firstTextAt?: number;
  completedAt?: number;
  isError: boolean;
  /**
   * `result.subtype` when it is one of Claude Code's known values ("success",
   * "error_during_execution", …), else "other": the CLI's string is not trusted to be content-free
   * (C6, C-R001, inspection P3E-I002).
   */
  resultSubtype?: string;
  /**
   * The kind of a failed turn (`isError`), classified from the result's fields; the result text
   * itself is not kept (phase-3-errors §3 step 2).
   */
  failureKind?: CliFailureKind;
  /** A top-level `rate_limit_event` status `rejected` was seen in this turn. */
  rateLimitRejected?: boolean;
  usage?: ClaudeUsage;
  /** Server-reported time to first token (`stream_event.ttft_ms`), when present. */
  serverTtftMs?: number;
  toolUseSeen: boolean;
  /**
   * `result.structured_output` of a successful turn run with `--json-schema` (the answer object;
   * phase-4-tools.md T2). Like `text`, a failed turn keeps none.
   */
  structuredOutput?: unknown;
}

export interface ClaudeInit {
  at: number;
  model?: string;
  toolsCount: number;
  mcpServersCount: number;
  listCounts: Record<string, number>;
}

type Json = Record<string, unknown>;

/** `result.subtype` values of Claude Code 2.1.312 (its binary); any other value reads "other". */
const RESULT_SUBTYPES: ReadonlySet<string> = new Set([
  'success',
  'error_during_execution',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
]);

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function readUsage(value: unknown): ClaudeUsage | undefined {
  if (!isObject(value)) return undefined;
  return {
    inputTokens: num(value.input_tokens),
    cacheCreationInputTokens: num(value.cache_creation_input_tokens),
    cacheReadInputTokens: num(value.cache_read_input_tokens),
    outputTokens: num(value.output_tokens),
  };
}

export function totalInputTokens(usage: ClaudeUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
}

const INIT_LIST_KEYS = [
  'tools',
  'mcp_servers',
  'slash_commands',
  'agents',
  'skills',
  'plugins',
] as const;

/**
 * Feeds stream-json lines and splits them into turns (one turn per `result` event).
 * Text is taken from partial `text_delta` events when present, otherwise from the
 * final `assistant` message, so it works with and without --include-partial-messages.
 */
export class ClaudeStreamReader {
  init?: ClaudeInit;
  readonly turns: ClaudeTurn[] = [];
  parseErrors = 0;
  private current: ClaudeTurn = ClaudeStreamReader.emptyTurn();
  private deltaText = '';
  private assistantText = '';

  /** @param onTextDelta called with every partial text chunk (streaming callers). */
  constructor(private readonly onTextDelta?: (text: string) => void) {}

  private static emptyTurn(): ClaudeTurn {
    return { text: '', isError: false, toolUseSeen: false };
  }

  get pendingTurn(): ClaudeTurn {
    return this.current;
  }

  push(line: string, at: number): ClaudeTurn | undefined {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.parseErrors++;
      return undefined;
    }
    if (!isObject(event)) return undefined;

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          const listCounts: Record<string, number> = {};
          for (const key of INIT_LIST_KEYS) {
            const value = event[key];
            listCounts[key] = Array.isArray(value) ? value.length : 0;
          }
          this.init = {
            at,
            model: typeof event.model === 'string' ? event.model : undefined,
            toolsCount: listCounts.tools ?? 0,
            mcpServersCount: listCounts.mcp_servers ?? 0,
            listCounts,
          };
        }
        return undefined;
      case 'stream_event':
        this.onStreamEvent(event, at);
        return undefined;
      case 'assistant':
        this.onAssistant(event, at);
        return undefined;
      case 'rate_limit_event':
        // Only the top-level status says whether requests are refused; a window or the overage
        // can be `rejected` while requests are still allowed (Claude Code 2.1.312).
        if (isObject(event.rate_limit_info) && event.rate_limit_info.status === 'rejected') {
          this.current.rateLimitRejected = true;
        }
        return undefined;
      case 'result':
        return this.onResult(event, at);
      default:
        return undefined;
    }
  }

  private onStreamEvent(event: Json, at: number): void {
    if (typeof event.ttft_ms === 'number' && this.current.serverTtftMs === undefined) {
      this.current.serverTtftMs = event.ttft_ms;
    }
    const inner = event.event;
    if (!isObject(inner)) return;
    if (inner.type === 'content_block_start' && isObject(inner.content_block)) {
      if (inner.content_block.type === 'tool_use') this.current.toolUseSeen = true;
    }
    if (inner.type === 'content_block_delta' && isObject(inner.delta)) {
      const delta = inner.delta;
      if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
        this.deltaText += delta.text;
        this.onTextDelta?.(delta.text);
        this.current.firstTextAt ??= at;
      }
    }
  }

  private onAssistant(event: Json, at: number): void {
    const message = event.message;
    if (!isObject(message) || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        this.assistantText += block.text;
        if (block.text !== '') this.current.firstTextAt ??= at;
      } else if (block.type === 'tool_use') {
        this.current.toolUseSeen = true;
      }
    }
  }

  private onResult(event: Json, at: number): ClaudeTurn {
    const turn = this.current;
    turn.text = this.deltaText !== '' ? this.deltaText : this.assistantText;
    turn.completedAt = at;
    turn.isError = event.is_error === true || event.subtype !== 'success';
    turn.resultSubtype =
      typeof event.subtype === 'string'
        ? RESULT_SUBTYPES.has(event.subtype)
          ? event.subtype
          : 'other'
        : undefined;
    if (turn.isError) {
      // A failed turn keeps no text: it can be the CLI's own error message (a synthetic
      // assistant message, e.g. "Invalid API key"), which never leaves the reader.
      turn.text = '';
      turn.failureKind = classifyClaudeResult({
        apiErrorStatus: event.api_error_status,
        text: event.result,
        rateLimitRejected: turn.rateLimitRejected,
      });
    } else if (event.structured_output !== undefined) {
      turn.structuredOutput = event.structured_output;
    }
    turn.usage = readUsage(event.usage);
    this.turns.push(turn);
    this.current = ClaudeStreamReader.emptyTurn();
    this.deltaText = '';
    this.assistantText = '';
    return turn;
  }
}
