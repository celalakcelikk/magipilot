// Bench-only Codex CLI client: a cold `codex exec` per request.
import type { Effort } from '../../../src/core/process/cliArgs';
import type { ProcessRegistry } from '../../../src/core/process/runner';
import { runCodexOnce } from '../../../src/core/process/oneShot';
import type { CompletionAttempt } from './types';

export interface CodexClientOptions {
  model: string;
  effort: Effort;
  timeoutMs: number;
}

export async function codexCold(
  registry: ProcessRegistry,
  options: CodexClientOptions,
  prompt: string,
): Promise<CompletionAttempt> {
  const result = await runCodexOnce(registry, {
    model: options.model,
    effort: options.effort,
    profile: 'lean',
    ignoreUserConfig: true,
    prompt,
    timeoutMs: options.timeoutMs,
  });
  const { reader, process: proc } = result;
  const text = result.lastMessage ?? reader.text;
  const finishedAt = reader.completedAt ?? result.endedAt;
  const ok = proc.exitCode === 0 && !reader.failed && !proc.timedOut;
  return {
    ok,
    error: ok
      ? undefined
      : proc.timedOut
        ? 'timeout'
        : `exit ${proc.exitCode}: ${reader.failureKind ?? proc.stderrTail.trim().split('\n').at(-1) ?? ''}`.slice(
            0,
            300,
          ),
    text,
    totalMs: finishedAt - result.startedAt,
    firstTextMs:
      reader.firstMessageAt !== undefined ? reader.firstMessageAt - result.startedAt : undefined,
    usage: reader.usage
      ? {
          inputTokens: reader.usage.inputTokens,
          cachedInputTokens: reader.usage.cachedInputTokens,
          outputTokens: reader.usage.outputTokens,
          reasoningOutputTokens: reader.usage.reasoningOutputTokens,
        }
      : undefined,
  };
}
