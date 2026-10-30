// Bench-only Claude Code CLI client in three modes: cold spawn, warm pool, stream-json session.
import {
  buildClaudeArgs,
  claudeStreamJsonUserMessage,
  type Effort,
} from '../../../src/core/process/cliArgs';
import {
  ClaudeStreamReader,
  totalInputTokens,
  type ClaudeTurn,
} from '../../../src/core/process/claudeStream';
import {
  makeEmptyDir,
  processFailure,
  removeDir,
  sleep,
  stopWithin,
  type ProcessHandle,
  type ProcessRegistry,
  type ProcessResult,
} from '../../../src/core/process/runner';
import { runClaudeOnce } from '../../../src/core/process/oneShot';
import { errorMessage, type CompletionAttempt } from './types';

/** How long a process may take to exit after its last result before it is killed. */
const SHUTDOWN_GRACE_MS = 5000;

export interface ClaudeClientOptions {
  model: string;
  systemPrompt: string;
  effort?: Effort;
  timeoutMs: number;
}

function turnToAttempt(
  turn: ClaudeTurn | undefined,
  sentAt: number,
  extra: Partial<CompletionAttempt> = {},
): CompletionAttempt {
  if (!turn) {
    return { ok: false, text: '', error: extra.error ?? 'no result event', ...extra };
  }
  return {
    ok: !turn.isError,
    error: turn.isError ? `result ${turn.failureKind ?? 'other'}` : undefined,
    text: turn.text,
    totalMs: turn.completedAt !== undefined ? turn.completedAt - sentAt : undefined,
    firstTextMs: turn.firstTextAt !== undefined ? turn.firstTextAt - sentAt : undefined,
    serverTtftMs: turn.serverTtftMs,
    usage: turn.usage
      ? {
          inputTokensTotal: totalInputTokens(turn.usage),
          cacheReadInputTokens: turn.usage.cacheReadInputTokens,
          outputTokens: turn.usage.outputTokens,
        }
      : undefined,
    ...extra,
  };
}

/**
 * Combines a parsed attempt with how its process ended (review P0-R2-001). A timeout, abort,
 * signal or non-zero exit makes the attempt fail even after a successful result event; the
 * text is kept for diagnosis but never enters the success statistics.
 */
export function classifyProcessAttempt(
  attempt: CompletionAttempt,
  process: ProcessResult,
): CompletionAttempt {
  // Same rule as the production backends (src/core/process/runner.ts processFailure).
  const failure = processFailure(process);
  if (!failure) return attempt;
  // Bench diagnostics only: production errors stay content-free (runner.ts processFailure).
  const stderr = process.stderrTail.trim().split('\n')[0];
  const detail = stderr ? `${failure}: ${stderr}` : failure;
  return {
    ...attempt,
    ok: false,
    error: attempt.ok ? `${detail} (after a result event)` : `${detail}; ${attempt.error ?? ''}`,
  };
}

/** Cold: a new process per request; latency includes process start-up. */
export async function claudeCold(
  registry: ProcessRegistry,
  options: ClaudeClientOptions,
  prompt: string,
): Promise<CompletionAttempt> {
  const args = buildClaudeArgs({
    model: options.model,
    systemPrompt: options.systemPrompt,
    effort: options.effort,
  });
  const result = await runClaudeOnce(registry, { args, prompt, timeoutMs: options.timeoutMs });
  const attempt = turnToAttempt(result.reader.turns.at(-1), result.promptSentAt, {
    initMs: result.reader.init ? result.reader.init.at - result.startedAt : undefined,
  });
  return classifyProcessAttempt(attempt, result.process);
}

interface WarmProcess {
  handle: ProcessHandle;
  reader: ClaudeStreamReader;
  cwd: string;
  spawnedAt: number;
  turnDone: Promise<ClaudeTurn | undefined>;
}

/**
 * Warm pool of size 1. Each process is single-use: it is spawned ahead of time with
 * `--input-format stream-json` (plain `-p` gives up after 3 s without stdin data, see
 * docs/cli-notes.md), receives exactly one user message, and is then closed.
 */
export class ClaudeWarmPool {
  private spare?: WarmProcess;

  constructor(
    private readonly registry: ProcessRegistry,
    private readonly options: ClaudeClientOptions,
    /** Minimum idle time between spawn and use, so start-up is really hidden. */
    private readonly minIdleMs = 3000,
  ) {}

  private spawn(): WarmProcess {
    const cwd = makeEmptyDir('magipilot-warm-');
    const reader = new ClaudeStreamReader();
    let resolveTurn: (turn: ClaudeTurn | undefined) => void = () => undefined;
    const turnDone = new Promise<ClaudeTurn | undefined>((resolve) => {
      resolveTurn = resolve;
    });
    const handle = this.registry.start(
      'claude',
      buildClaudeArgs({
        model: this.options.model,
        systemPrompt: this.options.systemPrompt,
        effort: this.options.effort,
        inputFormat: 'stream-json',
      }),
      {
        cwd,
        onLine: (line, at) => {
          const turn = reader.push(line, at);
          if (turn) resolveTurn(turn);
        },
      },
    );
    void handle.done.then(() => resolveTurn(undefined));
    return { handle, reader, cwd, spawnedAt: Date.now(), turnDone };
  }

  /** Spawns the spare process if there is none. */
  prime(): void {
    this.spare ??= this.spawn();
  }

  async complete(prompt: string): Promise<CompletionAttempt> {
    this.prime();
    const proc = this.spare!;
    this.spare = undefined;
    const idle = Date.now() - proc.spawnedAt;
    if (idle < this.minIdleMs) await sleep(this.minIdleMs - idle);
    const sentAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    let attempt: CompletionAttempt;
    try {
      proc.handle.end(claudeStreamJsonUserMessage(prompt));
      const turn = await Promise.race([
        proc.turnDone,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), this.options.timeoutMs);
        }),
      ]);
      attempt = turn
        ? {
            ...turnToAttempt(turn, sentAt),
            initMs: proc.reader.init ? proc.reader.init.at - proc.handle.startedAt : undefined,
          }
        : turnToAttempt(undefined, sentAt, {
            error: `no result within ${this.options.timeoutMs} ms`,
          });
    } catch (err) {
      attempt = { ok: false, text: '', error: errorMessage(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    // stdin is already closed. After a result the CLI gets a grace period to exit; without one it
    // is killed at once. A kill or non-zero exit fails the attempt (classifyProcessAttempt).
    const processResult = await stopWithin(proc.handle, attempt.ok ? SHUTDOWN_GRACE_MS : 0);
    removeDir(proc.cwd);
    // Pre-spawn the next process right away, as a real pool would.
    this.prime();
    return classifyProcessAttempt(attempt, processResult);
  }

  async dispose(): Promise<void> {
    const spare = this.spare;
    this.spare = undefined;
    if (spare) {
      await stopWithin(spare.handle, 0);
      removeDir(spare.cwd);
    }
  }
}

/**
 * One long-lived stream-json conversation; every request is appended as a new user turn.
 * After a timeout (or if the process dies) the session is killed and never reused, so a late
 * answer can never be attributed to a later request.
 */
export class ClaudeSession {
  private readonly cwd = makeEmptyDir('magipilot-session-');
  private readonly reader = new ClaudeStreamReader();
  private readonly handle: ProcessHandle;
  private resolveTurn?: (turn: ClaudeTurn | undefined) => void;
  private unavailable?: string;

  constructor(
    registry: ProcessRegistry,
    private readonly options: ClaudeClientOptions,
  ) {
    this.handle = registry.start(
      'claude',
      buildClaudeArgs({
        model: options.model,
        systemPrompt: options.systemPrompt,
        effort: options.effort,
        inputFormat: 'stream-json',
      }),
      {
        cwd: this.cwd,
        onLine: (line, at) => {
          const turn = this.reader.push(line, at);
          if (turn) this.resolveTurn?.(turn);
        },
      },
    );
    void this.handle.done.then(() => {
      this.unavailable ??= 'session process exited';
      this.resolveTurn?.(undefined);
    });
  }

  async complete(prompt: string): Promise<CompletionAttempt> {
    if (this.unavailable) {
      return { ok: false, text: '', error: `session unavailable: ${this.unavailable}` };
    }
    const sentAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const turn = await new Promise<ClaudeTurn | undefined>((resolve) => {
      this.resolveTurn = resolve;
      timer = setTimeout(() => resolve(undefined), this.options.timeoutMs);
      this.handle.write(claudeStreamJsonUserMessage(prompt));
    });
    if (timer) clearTimeout(timer);
    this.resolveTurn = undefined;
    if (!turn) {
      this.unavailable ??= `no result within ${this.options.timeoutMs} ms`;
      await stopWithin(this.handle, 0);
      return turnToAttempt(undefined, sentAt, { error: this.unavailable });
    }
    return turnToAttempt(turn, sentAt);
  }

  async dispose(): Promise<void> {
    this.unavailable ??= 'disposed';
    this.handle.end();
    await stopWithin(this.handle, SHUTDOWN_GRACE_MS);
    removeDir(this.cwd);
  }
}
