// Bench matrix (docs/plans/phase-0.md §4.3). Every row runs the same samples sequentially.
import type { ProcessRegistry } from '../../src/core/process/runner';
import { claudeCold, ClaudeSession, ClaudeWarmPool } from './clients/claude';
import { codexCold } from './clients/codex';
import { ollamaGenerate, ollamaUnload } from './clients/ollama';
import { openAiComplete } from './clients/openaiCompat';
import type { CompletionAttempt } from './clients/types';
import {
  codexCompletionPrompt,
  completionUserPrompt,
  COMPLETION_SYSTEM_PROMPT,
  qwenFimPrompt,
} from './prompt';
import { prodClaudeRow, prodLocalRow } from './production';
import type { BenchSample } from './samples';

export const BENCH_SETTINGS = {
  maxTokens: 128,
  temperature: 0.2,
  localTimeoutMs: 30_000,
  claudeTimeoutMs: 60_000,
  codexTimeoutMs: 120_000,
  claudeEffort: 'low',
  codexEffort: 'low',
  ollamaKeepAlive: '30m',
} as const;

export interface RowContext {
  registry: ProcessRegistry;
  ollamaUrl: string;
}

export interface BenchRow {
  id: string;
  backend: string;
  mode: string;
  model: string;
  notes: string;
  /** Runs before the first sample; returns facts worth reporting (e.g. model load time). */
  setup?(ctx: RowContext): Promise<Record<string, unknown>>;
  complete(ctx: RowContext, sample: BenchSample): Promise<CompletionAttempt>;
  teardown?(ctx: RowContext): Promise<void>;
}

const QWEN_RAW_STOP = [
  '<|endoftext|>',
  '<|file_sep|>',
  '<|fim_prefix|>',
  '<|fim_suffix|>',
  '<|fim_middle|>',
  '<|im_end|>',
];

const WARMUP_SAMPLE: BenchSample = {
  id: 'warmup',
  languageId: 'python',
  filePath: 'src/warmup.py',
  prefix: 'def square(x):\n    return ',
  suffix: '\n',
  expected: 'x * x',
};

function ollamaRow(
  id: string,
  model: string,
  fim: 'suffix' | 'raw',
  notes: string,
  unloadAfter: boolean,
): BenchRow {
  const request = (ctx: RowContext, sample: BenchSample): ReturnType<typeof ollamaGenerate> =>
    ollamaGenerate({
      baseUrl: ctx.ollamaUrl,
      model,
      ...(fim === 'raw'
        ? { prompt: qwenFimPrompt(sample), raw: true, stop: QWEN_RAW_STOP }
        : { prompt: sample.prefix, suffix: sample.suffix }),
      numPredict: BENCH_SETTINGS.maxTokens,
      temperature: BENCH_SETTINGS.temperature,
      keepAlive: BENCH_SETTINGS.ollamaKeepAlive,
      timeoutMs: fim === 'raw' ? 120_000 : BENCH_SETTINGS.localTimeoutMs,
    });
  return {
    id,
    backend: 'Ollama /api/generate',
    mode: fim === 'raw' ? 'stream, raw FIM tokens' : 'stream, suffix',
    model,
    notes,
    async setup(ctx) {
      // Fresh load (no cached prompt state from earlier runs), then an excluded warm-up request
      // that loads the model and reports the load time.
      await ollamaUnload(ctx.ollamaUrl, model);
      const warmup = await request(ctx, WARMUP_SAMPLE);
      return {
        warmupOk: warmup.ok,
        warmupMs: warmup.totalMs,
        modelLoadMs: warmup.loadMs,
        warmupError: warmup.error,
      };
    },
    complete: async (ctx, sample) => {
      const { loadMs: _loadMs, ...attempt } = await request(ctx, sample);
      return attempt;
    },
    async teardown(ctx) {
      if (unloadAfter) await ollamaUnload(ctx.ollamaUrl, model);
    },
  };
}

function claudeColdRow(id: string, alias: string): BenchRow {
  return {
    id,
    backend: 'Claude CLI',
    mode: 'cold spawn per request',
    model: alias,
    notes: `--effort ${BENCH_SETTINGS.claudeEffort}`,
    complete: (ctx, sample) =>
      claudeCold(
        ctx.registry,
        {
          model: alias,
          systemPrompt: COMPLETION_SYSTEM_PROMPT,
          effort: BENCH_SETTINGS.claudeEffort,
          timeoutMs: BENCH_SETTINGS.claudeTimeoutMs,
        },
        completionUserPrompt(sample),
      ),
  };
}

function codexRow(id: string, model: string): BenchRow {
  return {
    id,
    backend: 'Codex CLI',
    mode: 'cold exec per request',
    model,
    notes: `effort ${BENCH_SETTINGS.codexEffort}, lean profile, --ignore-user-config`,
    complete: (ctx, sample) =>
      codexCold(
        ctx.registry,
        {
          model,
          effort: BENCH_SETTINGS.codexEffort,
          timeoutMs: BENCH_SETTINGS.codexTimeoutMs,
        },
        codexCompletionPrompt(sample),
      ),
  };
}

export function createMatrix(): BenchRow[] {
  const claudeHaiku = {
    model: 'haiku',
    systemPrompt: COMPLETION_SYSTEM_PROMPT,
    effort: BENCH_SETTINGS.claudeEffort,
    timeoutMs: BENCH_SETTINGS.claudeTimeoutMs,
  } as const;
  let pool: ClaudeWarmPool | undefined;
  let session: ClaudeSession | undefined;

  return [
    // Both 1.5b rows start from a freshly loaded model: Ollama reuses cached prompt state, so a
    // row that follows another row with the same prompts would otherwise skip prompt processing.
    ollamaRow(
      'ollama-1.5b',
      'qwen2.5-coder:1.5b',
      'suffix',
      'warm-up excluded; unloaded after the row',
      true,
    ),
    {
      id: 'oai-1.5b',
      backend: 'Ollama /v1/completions (OpenAI-compatible)',
      mode: 'stream, suffix',
      model: 'qwen2.5-coder:1.5b',
      notes: 'fresh model load + warm-up excluded; unloaded after the row',
      async setup(ctx) {
        await ollamaUnload(ctx.ollamaUrl, 'qwen2.5-coder:1.5b');
        const warmup = await openAiComplete({
          baseUrl: ctx.ollamaUrl,
          model: 'qwen2.5-coder:1.5b',
          prompt: WARMUP_SAMPLE.prefix,
          suffix: WARMUP_SAMPLE.suffix,
          maxTokens: BENCH_SETTINGS.maxTokens,
          temperature: BENCH_SETTINGS.temperature,
          timeoutMs: BENCH_SETTINGS.localTimeoutMs,
        });
        return { warmupOk: warmup.ok, warmupMs: warmup.totalMs, warmupError: warmup.error };
      },
      complete: (ctx, sample) =>
        openAiComplete({
          baseUrl: ctx.ollamaUrl,
          model: 'qwen2.5-coder:1.5b',
          prompt: sample.prefix,
          suffix: sample.suffix,
          maxTokens: BENCH_SETTINGS.maxTokens,
          temperature: BENCH_SETTINGS.temperature,
          timeoutMs: BENCH_SETTINGS.localTimeoutMs,
        }),
      teardown: (ctx) => ollamaUnload(ctx.ollamaUrl, 'qwen2.5-coder:1.5b'),
    },
    ollamaRow(
      'ollama-30b-raw',
      'qwen3-coder:30b',
      'raw',
      'warm-up excluded; unloaded after the row',
      true,
    ),
    claudeColdRow('claude-haiku-cold', 'haiku'),
    {
      id: 'claude-haiku-warm',
      backend: 'Claude CLI',
      mode: 'warm pool (size 1, single-use stream-json process)',
      model: 'haiku',
      notes: `≥3 s idle before use; --effort ${BENCH_SETTINGS.claudeEffort}`,
      setup(ctx) {
        pool = new ClaudeWarmPool(ctx.registry, claudeHaiku);
        pool.prime();
        return Promise.resolve({});
      },
      complete: (_ctx, sample) => pool!.complete(completionUserPrompt(sample)),
      async teardown() {
        await pool?.dispose();
        pool = undefined;
      },
    },
    {
      id: 'claude-haiku-session',
      backend: 'Claude CLI',
      mode: 'one stream-json session, 20 turns',
      model: 'haiku',
      notes: `context grows per turn; --effort ${BENCH_SETTINGS.claudeEffort}`,
      setup(ctx) {
        session = new ClaudeSession(ctx.registry, claudeHaiku);
        return Promise.resolve({});
      },
      complete: (_ctx, sample) => session!.complete(completionUserPrompt(sample)),
      async teardown() {
        await session?.dispose();
        session = undefined;
      },
    },
    claudeColdRow('claude-sonnet-cold', 'sonnet'),
    claudeColdRow('claude-opus-cold', 'opus'),
    claudeColdRow('claude-fable-cold', 'fable'),
    codexRow('codex-luna-cold', 'gpt-6-luna'),
    codexRow('codex-sol-cold', 'gpt-6.1-sol'),
    // Faz 1: the production pipeline (src/core), compared with claude-haiku-warm / -cold above.
    prodClaudeRow('prod-claude-warm', 1, BENCH_SETTINGS),
    // Faz 1 Loop C: the local production backends (AC5: p50 < 400 ms).
    prodLocalRow('prod-ollama-1.5b', 'ollama'),
    prodLocalRow('prod-oai-1.5b', 'openai-compat'),
    prodClaudeRow('prod-claude-cold', 0, BENCH_SETTINGS),
  ];
}
