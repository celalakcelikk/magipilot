// Incremental reader for `codex exec --json` output.
// Event shapes are taken from real captures in test/fixtures/codex/.

import { classifyCodexMessage, CODEX_RETRY, type CliFailureKind } from '../backends/failures';

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export class CodexJsonlReader {
  threadId?: string;
  /** Final agent message text (the last `agent_message` item wins). */
  text = '';
  firstMessageAt?: number;
  turnStartedAt?: number;
  completedAt?: number;
  usage?: CodexUsage;
  failed = false;
  /**
   * The kind of the failure, classified from the failure messages; the messages themselves are
   * not kept, since they may quote the prompt (phase-3-errors §3 step 2, C6).
   */
  failureKind?: CliFailureKind;
  /** `turn.failed` and fatal `error` events. */
  errorCount = 0;
  /** Nonfatal reports: `error` items (configuration warnings) and retried connection errors. */
  warningCount = 0;
  parseErrors = 0;

  push(line: string, at: number): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.parseErrors++;
      return;
    }
    if (!isObject(event)) return;

    switch (event.type) {
      case 'thread.started':
        if (typeof event.thread_id === 'string') this.threadId = event.thread_id;
        return;
      case 'turn.started':
        this.turnStartedAt ??= at;
        return;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.onItem(event.item, at, event.type === 'item.completed');
        return;
      case 'turn.completed':
        this.completedAt = at;
        if (isObject(event.usage)) {
          this.usage = {
            inputTokens: num(event.usage.input_tokens),
            cachedInputTokens: num(event.usage.cached_input_tokens),
            outputTokens: num(event.usage.output_tokens),
            reasoningOutputTokens: num(event.usage.reasoning_output_tokens),
          };
        }
        return;
      case 'turn.failed':
      case 'error': {
        const error = isObject(event.error) ? event.error.message : event.message;
        const message = typeof error === 'string' ? error : '';
        // "Reconnecting... 2/5 (...)": the CLI retries by itself; `turn.failed` follows if it gives up.
        if (event.type === 'error' && CODEX_RETRY.test(message)) {
          this.warningCount++;
          return;
        }
        this.failed = true;
        this.errorCount++;
        const kind = classifyCodexMessage(message);
        if (kind !== undefined) this.failureKind = kind;
        this.failureKind ??= 'other';
        this.completedAt = at;
        return;
      }
      default:
        return;
    }
  }

  private onItem(item: unknown, at: number, completed: boolean): void {
    if (!isObject(item)) return;
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      if (item.text !== '') this.firstMessageAt ??= at;
      if (completed) this.text = item.text;
    } else if (item.type === 'error' && completed && typeof item.message === 'string') {
      this.warningCount++;
    }
  }
}
