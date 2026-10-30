// Codex CLI backend (PLAN §5, docs/cli-notes.md): a cold `codex exec` per call, lean profile,
// --ignore-user-config, read-only sandbox, empty temp cwd; the prompt is written to stdin and stdin
// is always closed (an open stdin makes Codex wait forever).
import type { Effort } from '../process/cliArgs';
import { runCodexOnce } from '../process/oneShot';
import { Operations } from '../process/operations';
import { probeExecutable, processFailure, type ProcessRegistry } from '../process/runner';
import { codexCompletionPrompt } from '../prompt/templates';
import { abortError, DEFAULT_CHAT_SYSTEM_PROMPT } from './claudeCli';
import { CliFailure, failureKind } from './failures';
import {
  ANSWER_SCHEMA,
  parseEnvelope,
  type StructuredAnswer,
  type StructuredChatBackend,
} from './structured';
import type { Backend, CompletionRequest, RunOptions } from './types';

export interface CodexCliOptions {
  path: string;
  model: string;
  effort: Effort;
  timeoutMs: number;
  processes: ProcessRegistry;
  /** Codex's `model_context_window` for chat calls (phase-4-context.md W5); absent: its default. */
  contextWindow?: number;
}

const AVAILABILITY_TTL_MS = 60_000;

export class CodexCliBackend implements Backend, StructuredChatBackend {
  readonly id = 'codex-cli' as const;
  readonly kind = 'chat' as const;
  private readonly operations = new Operations('Codex CLI backend');
  private availability?: { at: number; value: boolean };
  private availabilityCheck?: Promise<boolean>;

  constructor(private readonly options: CodexCliOptions) {}

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

  private exec(prompt: string, outer: AbortSignal, outputSchema?: object): Promise<string> {
    if (outer.aborted) return Promise.reject(abortError());
    return this.operations.run(outer, async (signal) => {
      const result = await runCodexOnce(this.options.processes, {
        command: this.options.path,
        model: this.options.model,
        effort: this.options.effort,
        ...(this.options.contextWindow !== undefined
          ? { contextWindow: this.options.contextWindow }
          : {}),
        profile: 'lean',
        ignoreUserConfig: true,
        prompt,
        timeoutMs: this.options.timeoutMs,
        signal,
        outputSchema,
      });
      if (signal.aborted) throw abortError();
      const failure = processFailure(result.process);
      // Precedence of phase-3-errors §3 step 3; fixed messages, since Codex error items may quote
      // the prompt (C6).
      const kind = failureKind({
        timedOut: failure === 'timeout',
        processFailed: failure !== undefined,
        readerKind: result.reader.failureKind,
        readerFailed: result.reader.failed,
        hasResult: true,
      });
      if (kind !== undefined) throw new CliFailure('codex', kind, failure ?? 'failed turn');
      return result.lastMessage ?? result.reader.text;
    });
  }

  complete(req: CompletionRequest): Promise<string> {
    return this.exec(codexCompletionPrompt(req), req.signal);
  }

  async *run(prompt: string, opts: RunOptions): AsyncIterable<string> {
    // Codex emits the final message at once; the stream has a single chunk.
    yield await this.exec(`${opts.system ?? DEFAULT_CHAT_SYSTEM_PROMPT}\n\n${prompt}`, opts.signal);
  }

  /** One tool-mode turn (phase-4-tools.md T2): `--output-schema` with the answer envelope. */
  async runStructured(prompt: string, opts: RunOptions): Promise<StructuredAnswer> {
    const text = await this.exec(
      `${opts.system ?? DEFAULT_CHAT_SYSTEM_PROMPT}\n\n${prompt}`,
      opts.signal,
      ANSWER_SCHEMA,
    );
    return parseEnvelope(text);
  }

  /** Aborts running calls (their processes are killed) and refuses new ones (P1-I003). */
  dispose(): void {
    this.operations.dispose();
  }
}
