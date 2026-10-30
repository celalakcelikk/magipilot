// Faz 1 bench rows that drive the production pipeline (docs/plans/phase-1.md §4.6,
// docs/plans/phase-1-local.md C7): cursor context → backend → postprocess, on the same 20
// samples. The raw output is scored like every other row; the post-processed text separately.
import { ClaudeCliBackend } from '../../src/core/backends/claudeCli';
import { OllamaBackend } from '../../src/core/backends/ollama';
import { OpenAiCompatBackend } from '../../src/core/backends/openaiCompat';
import { LOCAL_TEMPERATURE, LOCAL_TIMEOUT_MS } from '../../src/core/backends/registry';
import type { Backend } from '../../src/core/backends/types';
import { INLINE_MAX_TOKENS } from '../../src/features/inline/rules';
import { ollamaUnload } from './clients/ollama';
import { extractCursorContext } from '../../src/core/context/cursor';
import { postprocess } from '../../src/core/postprocess';
import { sleep } from '../../src/core/process/runner';
import { errorMessage } from './clients/types';
import type { BenchRow } from './matrix';
import type { BenchSample } from './samples';

const MAX_PREFIX_CHARS = 3000;
const MAX_SUFFIX_CHARS = 1000;
const MAX_LINES = 8;
/** Typing pause before each warm request so the spare is idle ≥ 3 s, as in the Faz 0 warm row. */
const WARM_IDLE_MS = 3000;

export interface ProdSettings {
  claudeEffort: 'low';
  claudeTimeoutMs: number;
}

export function prodClaudeRow(id: string, warmPoolSize: number, settings: ProdSettings): BenchRow {
  let backend: ClaudeCliBackend | undefined;
  return {
    id,
    backend: 'Claude CLI (production backend)',
    mode:
      warmPoolSize > 0
        ? `ClaudeCliBackend, warm pool size ${warmPoolSize}`
        : 'ClaudeCliBackend, cold spawn per request',
    model: 'haiku',
    notes: `--effort ${settings.claudeEffort}; postprocess maxLines ${MAX_LINES}${warmPoolSize > 0 ? `; ${WARM_IDLE_MS} ms pause before each request (not timed)` : ''}`,
    setup(ctx) {
      backend = new ClaudeCliBackend({
        path: 'claude',
        model: 'haiku',
        effort: settings.claudeEffort,
        warmPoolSize,
        disableNonessentialTraffic: true,
        timeoutMs: settings.claudeTimeoutMs,
        processes: ctx.registry,
      });
      backend.prime();
      return Promise.resolve({});
    },
    async complete(_ctx, sample: BenchSample) {
      if (warmPoolSize > 0) await sleep(WARM_IDLE_MS);
      const text = sample.prefix + sample.suffix;
      const { prefix, suffix } = extractCursorContext(
        text,
        sample.prefix.length,
        MAX_PREFIX_CHARS,
        MAX_SUFFIX_CHARS,
      );
      const sentAt = Date.now();
      try {
        const raw = await backend!.complete({
          prefix,
          suffix,
          languageId: sample.languageId,
          filePath: sample.filePath,
          snippets: [],
          maxTokens: 128,
          signal: AbortSignal.timeout(settings.claudeTimeoutMs + 5000),
        });
        const totalMs = Date.now() - sentAt;
        const timing = backend!.lastTiming;
        const resultMs =
          timing?.resultAt !== undefined ? timing.resultAt - timing.sentAt : undefined;
        const processed =
          postprocess(raw, {
            prefix,
            suffix,
            maxLines: MAX_LINES,
            languageId: sample.languageId,
          }) ?? '';
        return { ok: true, text: raw, totalMs, resultMs, processed };
      } catch (err) {
        return { ok: false, text: '', error: errorMessage(err) };
      }
    },
    teardown() {
      backend?.dispose();
      backend = undefined;
      return Promise.resolve();
    },
  };
}

/** The pipeline for one sample: cursor context, the backend call (timed), post-processing. */
async function runPipeline(
  backend: Backend,
  sample: BenchSample,
  maxTokens: number,
  timeoutMs: number,
): Promise<{ raw: string; totalMs: number; processed: string }> {
  const text = sample.prefix + sample.suffix;
  const { prefix, suffix } = extractCursorContext(
    text,
    sample.prefix.length,
    MAX_PREFIX_CHARS,
    MAX_SUFFIX_CHARS,
  );
  const sentAt = Date.now();
  const raw = await backend.complete({
    prefix,
    suffix,
    languageId: sample.languageId,
    filePath: sample.filePath,
    snippets: [],
    maxTokens,
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });
  const totalMs = Date.now() - sentAt;
  const processed =
    postprocess(raw, {
      prefix,
      suffix,
      maxLines: MAX_LINES,
      languageId: sample.languageId,
      backendKind: backend.kind,
    }) ?? '';
  return { raw, totalMs, processed };
}

const LOCAL_MODEL = 'qwen2.5-coder:1.5b';
const WARMUP: BenchSample = {
  id: 'warmup',
  languageId: 'python',
  filePath: 'src/warmup.py',
  prefix: 'def square(x):\n    return ',
  suffix: '\n',
  expected: 'x * x',
};

/**
 * prod-ollama-1.5b / prod-oai-1.5b (C7): the Loop B backends with the extension's values
 * (timeout, temperature, maxTokens). As in Faz 0, the model is unloaded first and a warm-up
 * request (model load) is excluded from the statistics.
 */
export function prodLocalRow(id: string, kind: 'ollama' | 'openai-compat'): BenchRow {
  let backend: OllamaBackend | OpenAiCompatBackend | undefined;
  return {
    id,
    backend:
      kind === 'ollama'
        ? 'Ollama (production OllamaBackend)'
        : 'Ollama /v1 (production OpenAiCompatBackend)',
    mode: kind === 'ollama' ? 'suffix FIM, stream' : 'fimTemplate server, stream',
    model: LOCAL_MODEL,
    notes: `maxTokens ${INLINE_MAX_TOKENS}, temperature ${LOCAL_TEMPERATURE}; fresh model load + warm-up excluded; postprocess maxLines ${MAX_LINES}`,
    async setup(ctx) {
      const options = {
        model: LOCAL_MODEL,
        timeoutMs: LOCAL_TIMEOUT_MS,
        temperature: LOCAL_TEMPERATURE,
      };
      backend =
        kind === 'ollama'
          ? new OllamaBackend({ ...options, baseUrl: ctx.ollamaUrl, fim: 'suffix' })
          : new OpenAiCompatBackend({ ...options, baseUrl: ctx.ollamaUrl, fimTemplate: 'server' });
      await ollamaUnload(ctx.ollamaUrl, LOCAL_MODEL);
      const available = await backend.isAvailable();
      const started = Date.now();
      let warmupOk = false;
      try {
        await runPipeline(backend, WARMUP, INLINE_MAX_TOKENS, LOCAL_TIMEOUT_MS * 6);
        warmupOk = true;
      } catch {
        /* reported below */
      }
      return { available, warmupOk, warmupMs: Date.now() - started };
    },
    async complete(_ctx, sample: BenchSample) {
      try {
        const { raw, totalMs, processed } = await runPipeline(
          backend!,
          sample,
          INLINE_MAX_TOKENS,
          LOCAL_TIMEOUT_MS,
        );
        return { ok: true, text: raw, totalMs, processed };
      } catch (err) {
        return { ok: false, text: '', error: errorMessage(err) };
      }
    },
    async teardown(ctx) {
      backend?.dispose();
      backend = undefined;
      await ollamaUnload(ctx.ollamaUrl, LOCAL_MODEL);
    },
  };
}
