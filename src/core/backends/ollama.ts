import { Operations } from '../process/operations';
import {
  buildFimPrompt,
  isFimFamily,
  type CustomFimTemplate,
  type FimFamily,
} from '../prompt/fimTemplates';
import type { Backend, CompletionRequest, RunOptions } from './types';

export interface LocalHttpOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

// Only locally constructed errors may cross the backend boundary.
class LocalFailure extends Error {}

/** Shared transport for the two local backends; owns cancellation and sanitized errors. */
export class LocalHttpClient {
  private readonly operations: Operations;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private cached?: { value: boolean; expires: number };
  private checking?: Promise<boolean>;

  constructor(
    private readonly id: string,
    private readonly options: LocalHttpOptions,
  ) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new Error(`${id}: invalid base URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`${id}: invalid base URL`);
    }
    this.baseUrl = url.href.replace(/\/$/, '');
    // Queries/fragments cannot act as base paths for endpoint concatenation.
    if (url.href.includes('?') || url.href.includes('#') || url.username || url.password)
      throw new Error(`${id}: invalid base URL`);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.operations = new Operations(id);
  }

  fail(category: string): never {
    throw new LocalFailure(`${this.id}: ${category}`);
  }

  async request<T>(
    path: string,
    body: unknown,
    outer: AbortSignal | undefined,
    consume: (response: Response) => Promise<T>,
    timeoutMs = this.options.timeoutMs ?? 10_000,
  ): Promise<T> {
    if (this.operations.disposed) this.fail('disposed');
    const operation = this.operations.begin(outer);
    let timedOut = false;
    let onAbort = (): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        const error = new LocalFailure(`${this.id}: ${timedOut ? 'timeout' : 'request aborted'}`);
        if (!timedOut) error.name = 'AbortError';
        reject(error);
      };
      operation.signal.addEventListener('abort', onAbort, { once: true });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      operation.abort();
    }, timeoutMs);
    try {
      if (operation.signal.aborted) onAbort();
      const work = async (): Promise<T> => {
        if (operation.signal.aborted) return await aborted;
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          ...(body === undefined
            ? {}
            : {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              }),
          signal: operation.signal,
          redirect: 'error',
        });
        if (!response.ok) this.fail(`HTTP ${response.status}`);
        return await consume(response);
      };
      return await Promise.race([aborted, work()]);
    } catch (error) {
      if (error instanceof LocalFailure) throw error;
      this.fail('request failed');
    } finally {
      clearTimeout(timer);
      operation.signal.removeEventListener('abort', onAbort);
      // Also cancel unread bodies after an early terminal marker or HTTP failure.
      operation.abort();
      operation.end();
    }
  }

  available(path: string, listed?: (value: unknown) => boolean): Promise<boolean> {
    if (this.operations.disposed) return Promise.resolve(false);
    if (this.cached && this.cached.expires > Date.now()) return Promise.resolve(this.cached.value);
    if (this.checking) return this.checking;
    this.checking = this.request(
      path,
      undefined,
      undefined,
      async (response) => (listed ? listed(await response.json()) : true),
      2_000,
    )
      .catch(() => false)
      .then((value) => {
        this.cached = { value, expires: Date.now() + 30_000 };
        this.checking = undefined;
        return !this.operations.disposed && value;
      });
    return this.checking;
  }

  dispose(): void {
    this.operations.dispose();
  }
}

/** Decode split UTF-8 and line boundaries, including the final unterminated line. */
export async function* responseLines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('missing body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const result = await reader.read();
      const value: unknown = result.value;
      const done = result.done;
      if (!done && !(value instanceof Uint8Array)) throw new Error('invalid stream chunk');
      buffer +=
        value instanceof Uint8Array ? decoder.decode(value, { stream: true }) : decoder.decode();
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
      }
      if (done) break;
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally {
    // Cancellation need not wait for an uncooperative stream implementation.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface OllamaOptions extends LocalHttpOptions {
  fim?: 'suffix' | 'raw';
  template?: FimFamily;
  custom?: CustomFimTemplate;
  keepAlive?: string | number;
}

export class OllamaBackend implements Backend {
  readonly id = 'ollama';
  readonly kind = 'fim';
  private readonly http: LocalHttpClient;

  constructor(private readonly options: OllamaOptions) {
    if (
      (options.fim !== undefined && options.fim !== 'suffix' && options.fim !== 'raw') ||
      (options.template !== undefined && !isFimFamily(options.template))
    ) {
      throw new Error('ollama: invalid configuration');
    }
    this.http = new LocalHttpClient(this.id, options);
  }

  isAvailable(): Promise<boolean> {
    return this.http.available('/api/tags', (value) => {
      const models = record(value)?.models;
      return (
        Array.isArray(models) &&
        models.some((item: unknown) => {
          const model = record(item);
          return [model?.name, model?.model].some(
            (name) =>
              name === this.options.model ||
              (!this.options.model.includes(':') && name === `${this.options.model}:latest`),
          );
        })
      );
    });
  }

  async complete(req: CompletionRequest): Promise<string> {
    let template: ReturnType<typeof buildFimPrompt>;
    try {
      template = buildFimPrompt(this.options.template ?? 'qwen', req, this.options.custom);
    } catch {
      return this.http.fail('invalid template');
    }
    const raw = this.options.fim === 'raw';
    // Ollama gates FIM on a non-empty suffix; an empty prompt is a load request.
    const prompt = req.prefix === '' ? '\n' : req.prefix;
    const suffix = req.suffix === '' ? '\n' : req.suffix;
    return this.http.request(
      '/api/generate',
      {
        model: this.options.model,
        prompt: raw ? template.prompt : prompt,
        ...(raw ? { raw: true } : { suffix }),
        stream: true,
        keep_alive: this.options.keepAlive ?? '30m',
        options: {
          num_predict: req.maxTokens,
          temperature: this.options.temperature ?? 0.2,
          stop: template.stop,
        },
      },
      req.signal,
      async (response) => {
        let text = '';
        for await (const line of responseLines(response)) {
          if (!line.trim()) continue;
          let chunk: Record<string, unknown> | undefined;
          try {
            chunk = record(JSON.parse(line));
          } catch {
            this.http.fail('malformed response');
          }
          if (!chunk) this.http.fail('malformed response');
          if ('error' in chunk) this.http.fail('server error');
          if (chunk.response !== undefined && typeof chunk.response !== 'string')
            this.http.fail('malformed response');
          text += chunk.response ?? '';
          if (chunk.done === true) return text;
        }
        return this.http.fail('stream ended early');
      },
    );
  }

  run(_prompt: string, _opts: RunOptions): AsyncIterable<string> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.reject(
              new Error('ollama is a fill-in-the-middle backend; chat is not supported'),
            ),
        };
      },
    };
  }

  dispose(): void {
    this.http.dispose();
  }
}
