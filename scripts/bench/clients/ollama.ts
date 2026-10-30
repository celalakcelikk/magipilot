// Minimal bench-only Ollama client (POST /api/generate, streaming NDJSON).
// The production backend is src/core/backends/ollama.ts (Faz 1, Codex-owned); this is not it.
import { errorMessage, type CompletionAttempt } from './types';

export interface OllamaGenerateOptions {
  baseUrl: string;
  model: string;
  prompt: string;
  /** FIM via the model template (requires the "insert" capability). */
  suffix?: string;
  /** Send the prompt verbatim (FIM tokens written by the caller). */
  raw?: boolean;
  numPredict: number;
  temperature: number;
  keepAlive: string | number;
  stop?: string[];
  timeoutMs: number;
}

interface OllamaChunk {
  response?: string;
  done?: boolean;
  error?: string;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') yield JSON.parse(line);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim() !== '') yield JSON.parse(buffer);
}

export async function ollamaGenerate(
  options: OllamaGenerateOptions,
): Promise<CompletionAttempt & { loadMs?: number }> {
  const body = {
    model: options.model,
    prompt: options.prompt,
    ...(options.suffix !== undefined ? { suffix: options.suffix } : {}),
    ...(options.raw ? { raw: true } : {}),
    stream: true,
    keep_alive: options.keepAlive,
    options: {
      temperature: options.temperature,
      num_predict: options.numPredict,
      ...(options.stop ? { stop: options.stop } : {}),
    },
  };
  const sentAt = Date.now();
  let text = '';
  let firstTextAt: number | undefined;
  try {
    const response = await fetch(`${options.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok || !response.body) {
      return {
        ok: false,
        text: '',
        error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
      };
    }
    let final: OllamaChunk | undefined;
    for await (const raw of readNdjson(response.body)) {
      const chunk = raw as OllamaChunk;
      if (chunk.error) {
        return { ok: false, text, error: `ollama: ${chunk.error}` };
      }
      if (chunk.response) {
        text += chunk.response;
        if (firstTextAt === undefined && chunk.response.trim() !== '') firstTextAt = Date.now();
      }
      if (chunk.done) final = chunk;
    }
    if (!final) {
      // A stream that ends without `done: true` was cut off; never count it as a completion.
      return { ok: false, text, error: 'stream ended without done=true' };
    }
    const doneAt = Date.now();
    return {
      ok: true,
      text,
      totalMs: doneAt - sentAt,
      firstTextMs: firstTextAt !== undefined ? firstTextAt - sentAt : undefined,
      loadMs: final.load_duration !== undefined ? Math.round(final.load_duration / 1e6) : undefined,
      usage: {
        promptEvalCount: final.prompt_eval_count ?? 0,
        evalCount: final.eval_count ?? 0,
      },
    };
  } catch (err) {
    return { ok: false, text, error: errorMessage(err) };
  }
}

/** Unloads a model from memory (keep_alive 0) so the next row does not compete for RAM. */
export async function ollamaUnload(baseUrl: string, model: string): Promise<void> {
  await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0 }),
    signal: AbortSignal.timeout(30_000),
  }).then((r) => r.text());
}
