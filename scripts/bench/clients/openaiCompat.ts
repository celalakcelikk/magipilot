// Minimal bench-only client for an OpenAI-compatible /v1/completions endpoint with `suffix`.
// The production backend is src/core/backends/openaiCompat.ts (Faz 1, Codex-owned); this is not it.
import { errorMessage, type CompletionAttempt } from './types';

export interface OpenAiCompletionOptions {
  baseUrl: string;
  model: string;
  prompt: string;
  suffix: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

interface CompletionChunk {
  choices?: { text?: string; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Yielded by readSse when the stream sends its `data: [DONE]` terminator. */
export const SSE_DONE = Symbol('sse-done');

/** Yields the JSON payloads of a server-sent-events stream, then SSE_DONE if `[DONE]` arrives. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf('\n');
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 1);
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          yield SSE_DONE;
          return;
        }
        if (data !== '') yield JSON.parse(data);
      }
      boundary = buffer.indexOf('\n');
    }
  }
}

export async function openAiComplete(options: OpenAiCompletionOptions): Promise<CompletionAttempt> {
  const sentAt = Date.now();
  let text = '';
  let firstTextAt: number | undefined;
  try {
    const response = await fetch(`${options.baseUrl}/v1/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        prompt: options.prompt,
        suffix: options.suffix,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        stream: true,
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok || !response.body) {
      return {
        ok: false,
        text: '',
        error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
      };
    }
    let usage: CompletionAttempt['usage'];
    let finished = false;
    for await (const raw of readSse(response.body)) {
      if (raw === SSE_DONE) {
        finished = true;
        continue;
      }
      const chunk = raw as CompletionChunk;
      if (chunk.choices?.[0]?.finish_reason) finished = true;
      if (chunk.error) {
        return { ok: false, text, error: `server: ${chunk.error.message ?? 'unknown error'}` };
      }
      const piece = chunk.choices?.[0]?.text ?? '';
      if (piece !== '') {
        text += piece;
        if (firstTextAt === undefined && piece.trim() !== '') firstTextAt = Date.now();
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
    }
    if (!finished) {
      // Neither a finish_reason nor [DONE]: the stream was cut off.
      return { ok: false, text, error: 'stream ended without finish_reason or [DONE]' };
    }
    return {
      ok: true,
      text,
      totalMs: Date.now() - sentAt,
      firstTextMs: firstTextAt !== undefined ? firstTextAt - sentAt : undefined,
      usage,
    };
  } catch (err) {
    return { ok: false, text, error: errorMessage(err) };
  }
}
