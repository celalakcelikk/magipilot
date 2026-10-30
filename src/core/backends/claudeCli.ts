// Claude Code CLI backend (PLAN §5, docs/cli-notes.md). Flags, isolation and the warm pool follow
// the Faz 0 measurements: isolated `-p` calls in an empty temp cwd, completion through single-use
// stream-json processes started ahead of time.
import { buildClaudeArgs, claudeStreamJsonUserMessage, type Effort } from '../process/cliArgs';
import { ClaudeStreamReader, type ClaudeTurn } from '../process/claudeStream';
import { runClaudeOnce } from '../process/oneShot';
import { Operations } from '../process/operations';
import {
  makeEmptyDir,
  probeExecutable,
  processFailure,
  removeDir,
  stopWithin,
  type ProcessHandle,
  type ProcessRegistry,
  type ProcessResult,
} from '../process/runner';
import { WarmPool } from '../process/warmPool';
import { COMPLETION_SYSTEM_PROMPT, completionUserPrompt } from '../prompt/templates';
import { CliFailure, failureKind } from './failures';
import {
  ANSWER_SCHEMA,
  parseEnvelope,
  type StructuredAnswer,
  type StructuredChatBackend,
} from './structured';
import type { Backend, CompletionRequest, RunOptions } from './types';

export const DEFAULT_CHAT_SYSTEM_PROMPT =
  'You are a helpful coding assistant. Answer concisely. You have no tools and cannot read files.';

export interface ClaudeCliOptions {
  /** Executable (`claude` on PATH by default). */
  path: string;
  model: string;
  effort?: Effort;
  /** Spare processes kept ready for completions; 0 = cold spawn per request. */
  warmPoolSize: number;
  /** Minimum age of a spare before use (bench comparability; the extension uses 0). */
  warmPoolMinIdleMs?: number;
  /** Sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 for every call (docs/cli-notes.md E12). */
  disableNonessentialTraffic: boolean;
  timeoutMs: number;
  processes: ProcessRegistry;
}

/** How long a CLI may take to exit after its result before it is killed. */
const SHUTDOWN_GRACE_MS = 5000;
const AVAILABILITY_TTL_MS = 60_000;

export function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

export interface CompletionTiming {
  /** When the prompt was written to the CLI. */
  sentAt: number;
  /** When the result event arrived (before the CLI exited). */
  resultAt?: number;
}

interface WarmProcess {
  handle: ProcessHandle;
  reader: ClaudeStreamReader;
  cwd: string;
  turn: Promise<ClaudeTurn | undefined>;
  exited: boolean;
}

export class ClaudeCliBackend implements Backend, StructuredChatBackend {
  readonly id = 'claude-cli' as const;
  readonly kind = 'chat' as const;
  /** Timing of the last complete() call (bench diagnostics; not part of Backend). */
  lastTiming?: CompletionTiming;
  private readonly pool?: WarmPool<WarmProcess>;
  private readonly operations = new Operations('Claude CLI backend');
  private availability?: { at: number; value: boolean };
  private availabilityCheck?: Promise<boolean>;

  constructor(private readonly options: ClaudeCliOptions) {
    if (options.warmPoolSize > 0) {
      this.pool = new WarmPool<WarmProcess>({
        size: options.warmPoolSize,
        minIdleMs: options.warmPoolMinIdleMs ?? 0,
        spawn: () => this.spawnWarm(),
        discard: (proc) => this.discard(proc),
        isAlive: (proc) => !proc.exited,
      });
    }
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.disableNonessentialTraffic
      ? { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
      : process.env;
  }

  isAvailable(): Promise<boolean> {
    if (process.platform === 'win32' || this.operations.disposed) return Promise.resolve(false);
    const cached = this.availability;
    if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    this.availabilityCheck ??= this.operations
      .run(undefined, (signal) =>
        probeExecutable(this.options.processes, this.options.path, signal),
      )
      .catch(() => false)
      .then((value) => {
        this.availability = { at: Date.now(), value };
        this.availabilityCheck = undefined;
        return value;
      });
    return this.availabilityCheck;
  }

  complete(req: CompletionRequest): Promise<string> {
    if (req.signal.aborted) return Promise.reject(abortError());
    const prompt = completionUserPrompt(req);
    return this.operations.run(req.signal, (signal) =>
      this.pool ? this.completeWarm(prompt, signal) : this.completeCold(prompt, signal),
    );
  }

  private spawnWarm(): WarmProcess {
    const cwd = makeEmptyDir('magipilot-claude-');
    let resolveTurn: (turn: ClaudeTurn | undefined) => void = () => undefined;
    const turn = new Promise<ClaudeTurn | undefined>((resolve) => {
      resolveTurn = resolve;
    });
    const reader = new ClaudeStreamReader();
    const handle = this.options.processes.start(
      this.options.path,
      buildClaudeArgs({
        model: this.options.model,
        systemPrompt: COMPLETION_SYSTEM_PROMPT,
        effort: this.options.effort,
        inputFormat: 'stream-json',
      }),
      {
        cwd,
        env: this.env(),
        onLine: (line, at) => {
          const done = reader.push(line, at);
          if (done) resolveTurn(done);
        },
      },
    );
    const proc: WarmProcess = { handle, reader, cwd, turn, exited: false };
    void handle.done.then(() => {
      proc.exited = true;
      resolveTurn(undefined);
      removeDir(cwd);
    });
    return proc;
  }

  private async discard(proc: WarmProcess): Promise<void> {
    await stopWithin(proc.handle, 0);
    removeDir(proc.cwd);
  }

  private async completeWarm(prompt: string, signal: AbortSignal): Promise<string> {
    const proc = await this.pool!.take();
    // From here on the process belongs to this request: every exit path below stops it,
    // including an abort that arrived before the prompt was written (inspection P1-I001).
    const onAbort = (): void => proc.handle.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let turn: ClaudeTurn | undefined;
    let result: ProcessResult | undefined;
    try {
      if (!signal.aborted) {
        this.lastTiming = { sentAt: Date.now() };
        proc.handle.end(claudeStreamJsonUserMessage(prompt));
        turn = await Promise.race([
          proc.turn,
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve(undefined);
            }, this.options.timeoutMs);
          }),
        ]);
        this.lastTiming.resultAt = turn?.completedAt;
      }
    } finally {
      if (timer) clearTimeout(timer);
      // After a result the CLI gets a grace period to exit; otherwise it is killed at once.
      const graceMs = turn && !turn.isError && !signal.aborted ? SHUTDOWN_GRACE_MS : 0;
      result = await stopWithin(proc.handle, graceMs);
      signal.removeEventListener('abort', onAbort);
      removeDir(proc.cwd);
    }
    if (signal.aborted) throw abortError();
    if (timedOut) throw new CliFailure('claude', 'timeout', 'timeout');
    // After an error result the process was stopped by us, so its exit status says nothing.
    if (turn?.isError) throw new CliFailure('claude', turn.failureKind ?? 'other', 'error result');
    return this.textOrThrow(turn, processFailure(result));
  }

  private async completeCold(prompt: string, signal: AbortSignal): Promise<string> {
    const result = await runClaudeOnce(this.options.processes, {
      command: this.options.path,
      args: buildClaudeArgs({
        model: this.options.model,
        systemPrompt: COMPLETION_SYSTEM_PROMPT,
        effort: this.options.effort,
      }),
      prompt,
      env: this.env(),
      timeoutMs: this.options.timeoutMs,
      signal,
    });
    this.lastTiming = {
      sentAt: result.promptSentAt,
      resultAt: result.reader.turns.at(-1)?.completedAt,
    };
    if (signal.aborted) throw abortError();
    return this.textOrThrow(result.reader.turns.at(-1), processFailure(result.process));
  }

  /**
   * The turn's text, or a `CliFailure` with the precedence of phase-3-errors §3 step 3: a timeout;
   * then a classified `not-logged-in` or `limit` result, also when the CLI then exits non-zero;
   * then `other` for a non-zero exit after a result (Faz 0 P0-R2-001), an unmatched error result or
   * no result. The messages are fixed: the CLI's text is not trusted to be content-free (C6).
   */
  private textOrThrow(turn: ClaudeTurn | undefined, failure: string | undefined): string {
    const kind = failureKind({
      timedOut: failure === 'timeout',
      processFailed: failure !== undefined,
      readerKind: turn?.failureKind,
      readerFailed: turn?.isError === true,
      hasResult: turn !== undefined,
    });
    if (kind !== undefined || !turn) {
      const detail = failure ?? (!turn ? 'no result' : 'error result');
      throw new CliFailure('claude', kind ?? 'other', detail);
    }
    return turn.text;
  }

  async *run(prompt: string, opts: RunOptions): AsyncIterable<string> {
    const operation = this.operations.begin(opts.signal);
    const signal = operation.signal;
    const chunks: string[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const running = runClaudeOnce(this.options.processes, {
      command: this.options.path,
      args: buildClaudeArgs({
        model: this.options.model,
        systemPrompt: opts.system ?? DEFAULT_CHAT_SYSTEM_PROMPT,
        effort: this.options.effort,
      }),
      prompt,
      env: this.env(),
      timeoutMs: this.options.timeoutMs,
      signal,
      onTextDelta: (text) => {
        chunks.push(text);
        wake?.();
      },
    }).finally(() => {
      finished = true;
      wake?.();
    });
    try {
      while (true) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
          continue;
        }
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      const result = await running;
      if (signal.aborted) throw abortError();
      this.textOrThrow(result.reader.turns.at(-1), processFailure(result.process));
    } finally {
      // A consumer that stops early (break/return) must not leave the CLI running: aborting the
      // operation's signal makes the registry kill the process.
      if (!finished) operation.abort();
      operation.end();
    }
  }

  /**
   * One tool-mode turn (phase-4-tools.md T2, T4): `--json-schema` with the answer envelope, still
   * without tools of its own (`--tools ""`); the answer is `result.structured_output`, read when
   * the CLI ends (no streaming).
   */
  runStructured(prompt: string, opts: RunOptions): Promise<StructuredAnswer> {
    if (opts.signal.aborted) return Promise.reject(abortError());
    return this.operations.run(opts.signal, async (signal) => {
      const result = await runClaudeOnce(this.options.processes, {
        command: this.options.path,
        args: buildClaudeArgs({
          model: this.options.model,
          systemPrompt: opts.system ?? DEFAULT_CHAT_SYSTEM_PROMPT,
          effort: this.options.effort,
          partialMessages: false,
          jsonSchema: JSON.stringify(ANSWER_SCHEMA),
        }),
        prompt,
        env: this.env(),
        timeoutMs: this.options.timeoutMs,
        signal,
      });
      if (signal.aborted) throw abortError();
      const turn = result.reader.turns.at(-1);
      this.textOrThrow(turn, processFailure(result.process));
      return parseEnvelope(turn!.structuredOutput);
    });
  }

  /** Aborts running requests, stops the spare processes and refuses new requests (P1-I003). */
  dispose(): void {
    this.operations.dispose();
    void this.pool?.dispose();
  }

  /** Starts the spare processes now (called when the backend is selected). */
  prime(): void {
    if (!this.operations.disposed) this.pool?.prime();
  }
}
