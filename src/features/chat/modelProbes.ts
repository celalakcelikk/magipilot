// The two model probes (docs/plans/phase-4-models.md M3). vscode-free. Like every CLI call they
// run through the ProcessRegistry (killed at deactivate and by a timeout), in an empty private
// folder, and send no prompt: neither probe is a model call.
import {
  buildClaudeModelProbeArgs,
  buildCodexModelProbeArgs,
  claudeContextUsageRequest,
  claudeInitializeRequest,
} from '../../core/process/cliArgs';
import {
  makeEmptyDir,
  removeDir,
  stopWithin,
  type ProcessHandle,
  type ProcessRegistry,
  type ProcessResult,
} from '../../core/process/runner';
import {
  claudeModelsFromLine,
  codexModelsFromCatalog,
  type DiscoveredModel,
  type DiscoveryFailure,
} from './modelDiscovery';
import { isModelId } from './models';
import { claudeWindowFromLine, WINDOW_REQUEST_ID } from './modelWindows';

export const PROBE_TIMEOUT_MS = 10_000;
/** After the answer and the closed stdin, the Claude probe gets this long to exit. */
const CLAUDE_EXIT_GRACE_MS = 3_000;
/** The Codex catalog was 686 KB on 2026-10-29; far more is not read. */
const MAX_CATALOG_CHARS = 8 * 1024 * 1024;

export interface ProbeOptions {
  /** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, as `ClaudeCliBackend` sets it (P4M-R002). */
  disableNonessentialTraffic?: boolean;
  timeoutMs?: number;
}

function failureOf(result: ProcessResult): DiscoveryFailure {
  // A spawn error (ENOENT) ends with neither an exit code nor a signal.
  if (result.exitCode === null && result.signal === null && !result.timedOut && !result.aborted) {
    return 'not-installed';
  }
  if (result.timedOut) return 'timeout';
  if (result.exitCode !== 0) return 'exit';
  return 'no-models';
}

/**
 * Asks Claude Code for its models with the SDK `initialize` request, then closes stdin without a
 * user message. The `control_response` is the only line read for content, and only its models.
 */
export async function probeClaudeModels(
  registry: ProcessRegistry,
  path: string,
  options: ProbeOptions = {},
): Promise<DiscoveredModel[] | DiscoveryFailure> {
  const cwd = makeEmptyDir('magipilot-models-');
  try {
    let found: DiscoveredModel[] | undefined;
    let answered: () => void = () => undefined;
    const answer = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const env = options.disableNonessentialTraffic
      ? { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
      : process.env;
    let handle: ProcessHandle | undefined;
    try {
      handle = registry.start(path, buildClaudeModelProbeArgs(), {
        cwd,
        env,
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        onLine: (line) => {
          if (found !== undefined) return;
          const models = claudeModelsFromLine(line);
          if (models === undefined) return;
          found = models;
          answered();
        },
      });
    } catch {
      return 'not-installed';
    }
    handle.write(claudeInitializeRequest('magipilot-models'));
    const ended = await Promise.race([answer.then(() => false), handle.done.then(() => true)]);
    if (!ended) {
      // The answer is in: no user message follows, and the CLI exits on the closed stdin.
      handle.end();
      await stopWithin(handle, CLAUDE_EXIT_GRACE_MS);
    }
    const result = await handle.done;
    // An answer counts only when the CLI then ends cleanly (inspection P4M-I003).
    if (result.timedOut || result.exitCode !== 0) return failureOf(result);
    if (found !== undefined) return found.length > 0 ? found : 'no-models';
    return 'no-models';
  } finally {
    removeDir(cwd);
  }
}

/**
 * Asks Claude Code for one model's context window (docs/plans/phase-4-context.md W1): the model is
 * chosen with `--model` at start, never with `set_model` (D3); stdin gets `initialize` and
 * `get_context_usage`, then is closed. No user message is sent, so it is not a model call. The
 * window counts only when the CLI then ends cleanly, as for the model probe (P4M-I003).
 */
export async function probeClaudeWindow(
  registry: ProcessRegistry,
  path: string,
  model: string,
  options: ProbeOptions = {},
): Promise<number | DiscoveryFailure> {
  if (!isModelId(model)) return 'unreadable';
  const cwd = makeEmptyDir('magipilot-window-');
  try {
    let found: number | null | undefined;
    let answered: () => void = () => undefined;
    const answer = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const env = options.disableNonessentialTraffic
      ? { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
      : process.env;
    let handle: ProcessHandle | undefined;
    try {
      handle = registry.start(path, buildClaudeModelProbeArgs(model), {
        cwd,
        env,
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        onLine: (line) => {
          if (found !== undefined) return;
          const window = claudeWindowFromLine(line, WINDOW_REQUEST_ID);
          if (window === undefined) return;
          found = window;
          answered();
        },
      });
    } catch {
      return 'not-installed';
    }
    handle.write(claudeInitializeRequest('magipilot-models'));
    handle.write(claudeContextUsageRequest(WINDOW_REQUEST_ID));
    const ended = await Promise.race([answer.then(() => false), handle.done.then(() => true)]);
    if (!ended) {
      handle.end();
      await stopWithin(handle, CLAUDE_EXIT_GRACE_MS);
    }
    const result = await handle.done;
    if (result.timedOut || result.exitCode !== 0) return failureOf(result);
    return typeof found === 'number' ? found : 'unreadable';
  } finally {
    removeDir(cwd);
  }
}

/** Reads `codex debug models` with stdin closed at once. */
export async function probeCodexModels(
  registry: ProcessRegistry,
  path: string,
  options: ProbeOptions = {},
): Promise<DiscoveredModel[] | DiscoveryFailure> {
  const cwd = makeEmptyDir('magipilot-models-');
  try {
    const lines: string[] = [];
    let chars = 0;
    let tooLarge = false;
    let handle: ProcessHandle | undefined;
    try {
      handle = registry.start(path, buildCodexModelProbeArgs(), {
        cwd,
        timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
        onLine: (line) => {
          if (tooLarge) return;
          chars += line.length + 1;
          if (chars > MAX_CATALOG_CHARS) {
            tooLarge = true;
            lines.length = 0;
            handle?.kill();
            return;
          }
          lines.push(line);
        },
      });
    } catch {
      return 'not-installed';
    }
    handle.end();
    const result = await handle.done;
    if (tooLarge) return 'unreadable';
    if (result.timedOut || result.exitCode !== 0) return failureOf(result);
    const models = codexModelsFromCatalog(lines.join('\n'));
    if (models === undefined) return 'unreadable';
    return models.length > 0 ? models : 'no-models';
  } finally {
    removeDir(cwd);
  }
}
