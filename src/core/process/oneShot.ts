// One-shot helpers that run a CLI in an empty private directory and collect its parsed output.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCodexArgs, type CodexArgsOptions } from './cliArgs';
import { ClaudeStreamReader } from './claudeStream';
import { CodexJsonlReader } from './codexJsonl';
import { makeEmptyDir, removeDir, type ProcessRegistry, type ProcessResult } from './runner';

export interface ClaudeRunOptions {
  args: readonly string[];
  prompt: string;
  timeoutMs: number;
  /** CLI executable (default `claude`). */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** Use an existing directory as cwd (cli-verify plants files there); otherwise a fresh empty one. */
  cwd?: string;
  /** Collects raw stdout lines (fixtures). */
  rawLines?: string[];
  /** Called with every partial text chunk (streaming callers). */
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ClaudeRunResult {
  reader: ClaudeStreamReader;
  process: ProcessResult;
  startedAt: number;
  promptSentAt: number;
  endedAt: number;
}

export async function runClaudeOnce(
  registry: ProcessRegistry,
  options: ClaudeRunOptions,
): Promise<ClaudeRunResult> {
  const cwd = options.cwd ?? makeEmptyDir('magipilot-claude-');
  const reader = new ClaudeStreamReader(options.onTextDelta);
  try {
    const handle = registry.start(options.command ?? 'claude', options.args, {
      cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onLine: (line, at) => {
        options.rawLines?.push(line);
        reader.push(line, at);
      },
    });
    const promptSentAt = Date.now();
    handle.end(options.prompt);
    const result = await handle.done;
    return {
      reader,
      process: result,
      startedAt: handle.startedAt,
      promptSentAt,
      endedAt: Date.now(),
    };
  } finally {
    if (options.cwd === undefined) removeDir(cwd);
  }
}

export interface CodexRunOptions extends Omit<
  CodexArgsOptions,
  'cwd' | 'lastMessagePath' | 'outputSchemaPath'
> {
  prompt: string;
  /**
   * JSON Schema of the final message (`--output-schema`). Written next to the `-o` file, outside
   * the agent's working root (phase-4-tools.md §4).
   */
  outputSchema?: object;
  timeoutMs: number;
  /** CLI executable (default `codex`). */
  command?: string;
  env?: NodeJS.ProcessEnv;
  rawLines?: string[];
  signal?: AbortSignal;
}

export interface CodexRunResult {
  reader: CodexJsonlReader;
  process: ProcessResult;
  /** Content of the `-o` file, if Codex wrote it. */
  lastMessage?: string;
  startedAt: number;
  endedAt: number;
  args: string[];
}

export async function runCodexOnce(
  registry: ProcessRegistry,
  options: CodexRunOptions,
): Promise<CodexRunResult> {
  const cwd = makeEmptyDir('magipilot-codex-');
  // The -o file lives in a sibling directory so the agent's working root stays empty.
  const outDir = makeEmptyDir('magipilot-codex-out-');
  const lastMessagePath = join(outDir, 'last-message.txt');
  const reader = new CodexJsonlReader();
  const outputSchemaPath =
    options.outputSchema !== undefined ? join(outDir, 'output-schema.json') : undefined;
  const args = buildCodexArgs({ ...options, cwd, lastMessagePath, outputSchemaPath });
  try {
    if (outputSchemaPath !== undefined) {
      writeFileSync(outputSchemaPath, JSON.stringify(options.outputSchema));
    }
    const handle = registry.start(options.command ?? 'codex', args, {
      cwd,
      env: options.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onLine: (line, at) => {
        options.rawLines?.push(line);
        reader.push(line, at);
      },
    });
    // Codex waits for EOF on stdin when the prompt is "-": always write and close.
    handle.end(options.prompt);
    const result = await handle.done;
    const lastMessage = existsSync(lastMessagePath)
      ? readFileSync(lastMessagePath, 'utf8')
      : undefined;
    return {
      reader,
      process: result,
      lastMessage,
      startedAt: handle.startedAt,
      endedAt: Date.now(),
      args,
    };
  } finally {
    removeDir(cwd);
    removeDir(outDir);
  }
}
