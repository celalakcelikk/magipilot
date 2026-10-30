import { describe, expect, it } from 'vitest';
import {
  OpenAiCompatBackend,
  type OpenAiCompatOptions,
} from '../../src/core/backends/openaiCompat';
import { buildFimPrompt } from '../../src/core/prompt/fimTemplates';
import { baseUrl, bodyOf, fakeFetch, localContract, request, stream } from './helpers/localHttp';

const success =
  'data: {"choices":[{"text":"  é中\\n","finish_reason":null}]}\r\n\r\ndata: [DONE]\r\n\r\n';
localContract({
  id: 'openai-compat',
  create: (options) => new OpenAiCompatBackend(options),
  success,
  partial: 'data: {"choices":[{"text":"partial"}]}\n\n',
  serverError: 'data: {"error":{"message":"PREFIX_SECRET SUFFIX_SECRET SERVER_SECRET"}}\n\n',
  malformed: 'data: {PREFIX_SECRET SUFFIX_SECRET MALFORMED_SECRET}\n\n',
  models: { data: [{ id: 'test' }] },
  missing: { data: [{ id: 'other' }] },
  availabilityPath: '/v1/models',
});

localContract({
  id: 'openai-compat',
  create: (options) => new OpenAiCompatBackend({ ...options, fimTemplate: 'qwen' }),
  success,
  partial: 'data: {"choices":[{"text":"partial"}]}\n\n',
  serverError: 'data: {"error":{"message":"PREFIX_SECRET SUFFIX_SECRET SERVER_SECRET"}}\n\n',
  malformed: 'data: {PREFIX_SECRET SUFFIX_SECRET MALFORMED_SECRET}\n\n',
  models: { data: [{ id: 'test' }] },
  missing: { data: [{ id: 'other' }] },
  availabilityPath: '/v1/models',
});

localContract({
  id: 'openai-compat',
  create: (options) => new OpenAiCompatBackend({ ...options, fimTemplate: 'infill' }),
  success: 'data: {"content":"  é中\\n","stop":false}\n\ndata: {"stop":true}\n\n',
  partial: 'data: {"content":"partial","stop":false}\n\n',
  serverError: 'data: {"error":"PREFIX_SECRET SUFFIX_SECRET SERVER_SECRET"}\n\n',
  malformed: 'data: {PREFIX_SECRET SUFFIX_SECRET MALFORMED_SECRET}\n\n',
  models: { data: [{ id: 'test' }] },
  missing: { data: [{ id: 'other' }] },
  availabilityPath: '/v1/models',
});

describe('OpenAI-compatible modes', () => {
  it.each([
    'server',
    'qwen',
    'deepseek-coder',
    'codestral',
    'starcoder',
    'custom',
    'infill',
  ] as const)('sends %s request format', async (fimTemplate) => {
    const infill = fimTemplate === 'infill';
    const fetchImpl = fakeFetch(() =>
      stream(infill ? 'data: {"content":"text","stop":true}\n\n' : success),
    );
    const custom = { template: '{suffix}::{prefix}', stop: ['STOP'] };
    const backend = new OpenAiCompatBackend({
      baseUrl,
      model: 'test',
      fetchImpl,
      fimTemplate,
      custom,
    });
    await backend.complete(request());
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `${baseUrl}${infill ? '/infill' : '/v1/completions'}`,
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const sampling = { stream: true, temperature: 0.2 };
    if (infill)
      expect(bodyOf(fetchImpl)).toEqual({
        ...sampling,
        input_prefix: request().prefix,
        input_suffix: request().suffix,
        input_extra: [{ filename: 'lib.ts', text: 'context' }],
        n_predict: 42,
      });
    else
      expect(bodyOf(fetchImpl)).toEqual({
        ...sampling,
        model: 'test',
        max_tokens: 42,
        ...(fimTemplate === 'server'
          ? { prompt: request().prefix, suffix: request().suffix }
          : buildFimPrompt(fimTemplate, request(), custom)),
      });
    backend.dispose();
  });

  it.each(['server', 'qwen', 'infill'] as const)(
    '%s handles empty context without changing other modes',
    async (fimTemplate) => {
      for (const [prefix, suffix] of [
        ['', 'after'],
        ['before', ''],
        ['', ''],
      ] as const) {
        const fetchImpl = fakeFetch(() =>
          stream(fimTemplate === 'infill' ? 'data: {"stop":true}\n\n' : success),
        );
        const backend = new OpenAiCompatBackend({ baseUrl, model: 'test', fetchImpl, fimTemplate });
        const req = { ...request(), prefix, suffix };
        await backend.complete(req);
        if (fimTemplate === 'server') {
          expect(bodyOf(fetchImpl)).toMatchObject({
            prompt: prefix === '' ? '\n' : prefix,
            suffix: suffix === '' ? '\n' : suffix,
          });
        } else if (fimTemplate === 'infill') {
          expect(bodyOf(fetchImpl)).toMatchObject({ input_prefix: prefix, input_suffix: suffix });
        } else {
          expect(bodyOf(fetchImpl).prompt).toBe(buildFimPrompt('qwen', req).prompt);
          expect(bodyOf(fetchImpl)).not.toHaveProperty('suffix');
        }
        backend.dispose();
      }
    },
  );

  it.each(['Server', 'unknown', null])('rejects invalid fimTemplate %j', (fimTemplate) => {
    expect(
      () => new OpenAiCompatBackend({ baseUrl, model: 'test', fimTemplate } as OpenAiCompatOptions),
    ).toThrow('openai-compat: invalid configuration');
  });

  it.each(['server', 'infill'] as const)(
    '%s rejects SSE error fields and events before DONE',
    async (fimTemplate) => {
      for (const errorEvent of [
        'error: {"message":"PREFIX_SECRET"}\n\n',
        'event: error\ndata: {"message":"PREFIX_SECRET"}\n\n',
        'data: {"message":"PREFIX_SECRET"}\nevent: error\n\n',
        'event: error\n\n',
      ]) {
        const fetchImpl = fakeFetch(() => stream(`${errorEvent}data: [DONE]\n\n`));
        const backend = new OpenAiCompatBackend({ baseUrl, model: 'test', fetchImpl, fimTemplate });
        const error: unknown = await backend.complete(request()).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('openai-compat: server error');
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(
          `${baseUrl}${fimTemplate === 'infill' ? '/infill' : '/v1/completions'}`,
        );
        backend.dispose();
      }
    },
  );

  it('defaults to server mode, drops snippets and supports zero temperature', async () => {
    const fetchImpl = fakeFetch(() => stream(success));
    const backend = new OpenAiCompatBackend({ baseUrl, model: 'test', fetchImpl, temperature: 0 });
    await backend.complete(request());
    expect(bodyOf(fetchImpl)).toEqual({
      model: 'test',
      prompt: request().prefix,
      suffix: request().suffix,
      max_tokens: 42,
      temperature: 0,
      stream: true,
    });
    backend.dispose();
  });

  it.each([
    'data: {"choices":[{"text":"ok","finish_reason":"stop"}]}\n\n',
    ': heartbeat\r\nevent: message\r\ndata: {"choices": [\r\ndata: {"text":"ok","finish_reason":"length"}]}\r\n\r\n',
    'data: {"choices":[],"usage":{}}\n\ndata: {"choices":[{"text":"ok"}]}\n\ndata: [DONE]',
  ])('accepts finish_reason, SSE fields, multiline data and final data: %s', async (value) => {
    const backend = new OpenAiCompatBackend({
      baseUrl,
      model: 'test',
      fetchImpl: fakeFetch(() => stream(value)),
    });
    expect(await backend.complete(request())).toBe('ok');
    backend.dispose();
  });

  it.each([
    'data: {"content":"partial","stop":false}\n\n',
    'data: [DONE]\n\n',
    'data: {"content":1,"stop":true}\n\n',
  ])('infill requires stop: true: %s', async (value) => {
    const backend = new OpenAiCompatBackend({
      baseUrl,
      model: 'test',
      fimTemplate: 'infill',
      fetchImpl: fakeFetch(() => stream(value)),
    });
    await expect(backend.complete(request())).rejects.toThrow();
    backend.dispose();
  });

  it('concatenates infill chunks', async () => {
    const backend = new OpenAiCompatBackend({
      baseUrl,
      model: 'test',
      fimTemplate: 'infill',
      fetchImpl: fakeFetch(() =>
        stream('data: {"content":"a","stop":false}\n\ndata: {"content":"b","stop":true}\n\n'),
      ),
    });
    expect(await backend.complete(request())).toBe('ab');
    backend.dispose();
  });

  it('an empty model requires only reachability', async () => {
    const backend = new OpenAiCompatBackend({
      baseUrl,
      model: '',
      fetchImpl: fakeFetch(() => new Response(null)),
    });
    expect(await backend.isAvailable()).toBe(true);
    backend.dispose();
  });

  it.each(['null', '{"choices":[{"text":1}]}', '{"choices":[null]}', '{"choices":"bad"}'])(
    'rejects malformed response shape %s',
    async (value) => {
      const backend = new OpenAiCompatBackend({
        baseUrl,
        model: 'test',
        fetchImpl: fakeFetch(() => stream(`data: ${value}\n\n`)),
      });
      await expect(backend.complete(request())).rejects.toThrow(
        'openai-compat: malformed response',
      );
      backend.dispose();
    },
  );
});
