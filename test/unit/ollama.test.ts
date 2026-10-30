import { describe, expect, it } from 'vitest';
import { OllamaBackend, type OllamaOptions } from '../../src/core/backends/ollama';
import { buildFimPrompt } from '../../src/core/prompt/fimTemplates';
import { baseUrl, bodyOf, fakeFetch, localContract, request, stream } from './helpers/localHttp';

const success = '{"response":"  é中\\n","done":false}\n{"done":true}';
localContract({
  id: 'ollama',
  create: (options) => new OllamaBackend(options),
  success,
  partial: '{"response":"partial"}\n',
  serverError: '{"error":"PREFIX_SECRET SUFFIX_SECRET SERVER_SECRET"}\n',
  malformed: '{PREFIX_SECRET SUFFIX_SECRET MALFORMED_SECRET}\n',
  models: { models: [{ name: 'test:latest' }] },
  missing: { models: [{ name: 'other' }] },
  availabilityPath: '/api/tags',
});

describe('Ollama modes', () => {
  it.each(['suffix', 'raw'] as const)('sends %s FIM with sampling and stops', async (fim) => {
    const fetchImpl = fakeFetch(() => stream(success));
    const backend = new OllamaBackend({ baseUrl, model: 'test', fetchImpl, fim });
    await backend.complete(request());
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${baseUrl}/api/generate`);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const template = buildFimPrompt('qwen', request());
    expect(bodyOf(fetchImpl)).toEqual({
      model: 'test',
      stream: true,
      keep_alive: '30m',
      prompt: fim === 'raw' ? template.prompt : request().prefix,
      ...(fim === 'raw' ? { raw: true } : { suffix: request().suffix }),
      options: { num_predict: 42, temperature: 0.2, stop: template.stop },
    });
    backend.dispose();
  });

  it.each([
    ['suffix', '', 'after'],
    ['suffix', 'before', ''],
    ['suffix', '', ''],
    ['raw', '', 'after'],
    ['raw', 'before', ''],
    ['raw', '', ''],
  ] as const)('%s preserves FIM with prefix=%j and suffix=%j', async (fim, prefix, suffix) => {
    const fetchImpl = fakeFetch(() => stream(success));
    const backend = new OllamaBackend({ baseUrl, model: 'test', fetchImpl, fim });
    const req = { ...request(), prefix, suffix };
    await backend.complete(req);
    if (fim === 'suffix') {
      expect(bodyOf(fetchImpl)).toMatchObject({
        prompt: prefix === '' ? '\n' : prefix,
        suffix: suffix === '' ? '\n' : suffix,
      });
    } else {
      expect(bodyOf(fetchImpl).prompt).toBe(buildFimPrompt('qwen', req).prompt);
      expect(bodyOf(fetchImpl)).not.toHaveProperty('suffix');
    }
    backend.dispose();
  });

  it.each([{ fim: 'Server' }, { template: 'unknown' }, { fim: null }, { template: null }])(
    'rejects invalid configuration %j',
    (invalid) => {
      expect(
        () => new OllamaBackend({ baseUrl, model: 'test', ...invalid } as OllamaOptions),
      ).toThrow('ollama: invalid configuration');
    },
  );

  it('defaults to suffix mode and supports keepAlive and temperature overrides', async () => {
    const fetchImpl = fakeFetch(() => stream(success));
    const backend = new OllamaBackend({
      baseUrl,
      model: 'test',
      fetchImpl,
      keepAlive: 0,
      temperature: 0,
    });
    await backend.complete(request());
    expect(bodyOf(fetchImpl)).toMatchObject({
      prompt: request().prefix,
      suffix: request().suffix,
      keep_alive: 0,
      options: { temperature: 0 },
    });
    expect(bodyOf(fetchImpl)).not.toHaveProperty('raw');
    expect(JSON.stringify(bodyOf(fetchImpl))).not.toContain('context');
    backend.dispose();
  });

  it('uses the selected raw template', async () => {
    const fetchImpl = fakeFetch(() => stream(success));
    const backend = new OllamaBackend({
      baseUrl,
      model: 'test',
      fetchImpl,
      fim: 'raw',
      template: 'codestral',
    });
    await backend.complete(request());
    expect(bodyOf(fetchImpl)).toMatchObject({
      prompt: '[SUFFIX]SUFFIX_SECRET[PREFIX] PREFIX_SECRET',
      options: { stop: ['</s>', '[PREFIX]', '[SUFFIX]'] },
    });
    backend.dispose();
  });

  it.each([{ name: 'test' }, { model: 'test:latest' }, { name: 'other', model: 'test' }])(
    'matches either model field: %j',
    async (model) => {
      const backend = new OllamaBackend({
        baseUrl,
        model: 'test',
        fetchImpl: fakeFetch(() => Response.json({ models: [model] })),
      });
      expect(await backend.isAvailable()).toBe(true);
      backend.dispose();
    },
  );

  it('does not match a different explicit tag', async () => {
    const backend = new OllamaBackend({
      baseUrl,
      model: 'test:small',
      fetchImpl: fakeFetch(() => Response.json({ models: [{ name: 'test:latest' }] })),
    });
    expect(await backend.isAvailable()).toBe(false);
    backend.dispose();
  });

  it.each(['{"response":1,"done":true}', 'null', '{"done":"true"}'])(
    'rejects invalid records or non-boolean terminal markers: %s',
    async (value) => {
      const backend = new OllamaBackend({
        baseUrl,
        model: 'test',
        fetchImpl: fakeFetch(() => stream(value)),
      });
      await expect(backend.complete(request())).rejects.toThrow();
      backend.dispose();
    },
  );
});
