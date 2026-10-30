import {
  buildFimPrompt,
  isFimFamily,
  type CustomFimTemplate,
  type FimFamily,
} from '../prompt/fimTemplates';
import { LocalHttpClient, record, responseLines, type LocalHttpOptions } from './ollama';
import type { Backend, CompletionRequest, RunOptions } from './types';

export interface OpenAiCompatOptions extends LocalHttpOptions {
  fimTemplate?: 'server' | 'infill' | FimFamily;
  custom?: CustomFimTemplate;
}

const SSE_ERROR = Symbol('sse-error');

// SSE events can span transport chunks and multiple data lines; preserve error markers.
async function* sseData(response: Response): AsyncGenerator<string | typeof SSE_ERROR> {
  let data: string[] = [];
  for await (const line of responseLines(response)) {
    if (
      line.startsWith('error:') ||
      (line.startsWith('event:') && line.slice(6).trim() === 'error')
    ) {
      yield SSE_ERROR;
      return;
    }
    if (line === '') {
      if (data.length) yield data.join('\n');
      data = [];
    } else if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (data.length) yield data.join('\n');
}

export class OpenAiCompatBackend implements Backend {
  readonly id = 'openai-compat';
  readonly kind = 'fim';
  private readonly http: LocalHttpClient;

  constructor(private readonly options: OpenAiCompatOptions) {
    if (
      options.fimTemplate !== undefined &&
      options.fimTemplate !== 'server' &&
      options.fimTemplate !== 'infill' &&
      !isFimFamily(options.fimTemplate)
    ) {
      throw new Error('openai-compat: invalid configuration');
    }
    this.http = new LocalHttpClient(this.id, options);
  }

  isAvailable(): Promise<boolean> {
    if (!this.options.model) return this.http.available('/v1/models');
    return this.http.available('/v1/models', (value) => {
      const data = record(value)?.data;
      return (
        Array.isArray(data) && data.some((item: unknown) => record(item)?.id === this.options.model)
      );
    });
  }

  async complete(req: CompletionRequest): Promise<string> {
    const mode = this.options.fimTemplate ?? 'server';
    let body: Record<string, unknown>;
    const sampling = { temperature: this.options.temperature ?? 0.2, stream: true };
    if (mode === 'infill') {
      body = {
        ...sampling,
        input_prefix: req.prefix,
        input_suffix: req.suffix,
        input_extra: req.snippets.map(({ path, text }) => ({ filename: path, text })),
        n_predict: req.maxTokens,
      };
    } else {
      body = { ...sampling, model: this.options.model, max_tokens: req.maxTokens };
      if (mode === 'server') {
        // Ollama gates FIM on a non-empty suffix; an empty prompt is a load request.
        Object.assign(body, {
          prompt: req.prefix === '' ? '\n' : req.prefix,
          suffix: req.suffix === '' ? '\n' : req.suffix,
        });
      } else {
        try {
          Object.assign(body, buildFimPrompt(mode, req, this.options.custom));
        } catch {
          return this.http.fail('invalid template');
        }
      }
    }
    return this.http.request(
      mode === 'infill' ? '/infill' : '/v1/completions',
      body,
      req.signal,
      async (response) => {
        let text = '';
        for await (const data of sseData(response)) {
          if (data === SSE_ERROR) this.http.fail('server error');
          if (data === '[DONE]') {
            if (mode === 'infill') this.http.fail('stream ended early');
            return text;
          }
          let chunk: Record<string, unknown> | undefined;
          try {
            chunk = record(JSON.parse(data));
          } catch {
            this.http.fail('malformed response');
          }
          if (!chunk) this.http.fail('malformed response');
          if ('error' in chunk) this.http.fail('server error');
          if (mode === 'infill') {
            if (chunk.content !== undefined && typeof chunk.content !== 'string')
              this.http.fail('malformed response');
            text += chunk.content ?? '';
            if (chunk.stop === true) return text;
          } else {
            if (!Array.isArray(chunk.choices)) this.http.fail('malformed response');
            const choice = record(chunk.choices[0]);
            // Empty choices occur in usage-only chunks.
            if (!choice) {
              if (chunk.choices.length === 0) continue;
              this.http.fail('malformed response');
            }
            if (choice.text !== undefined && typeof choice.text !== 'string')
              this.http.fail('malformed response');
            text += choice.text ?? '';
            if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0)
              return text;
          }
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
              new Error('openai-compat is a fill-in-the-middle backend; chat is not supported'),
            ),
        };
      },
    };
  }

  dispose(): void {
    this.http.dispose();
  }
}
