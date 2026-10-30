import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Backend, CompletionRequest } from '../../../src/core/backends/types';
import type { LocalHttpOptions } from '../../../src/core/backends/ollama';

export const baseUrl = 'http://localhost:1234/proxy';
export function request(): CompletionRequest {
  return {
    prefix: 'PREFIX_SECRET',
    suffix: 'SUFFIX_SECRET',
    languageId: 'typescript',
    filePath: 'src/main.ts',
    snippets: [{ path: 'lib.ts', text: 'context' }],
    maxTokens: 42,
    signal: new AbortController().signal,
  };
}

export function stream(text: string, status = 200): Response {
  const bytes = new TextEncoder().encode(text);
  // One byte per chunk exercises JSON, CRLF and multibyte UTF-8 boundaries.
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
    { status },
  );
}

const fetches: Mock<typeof fetch>[] = [];

// Check recorded calls outside the backend's error boundary so it cannot swallow assertions.
afterEach(() => {
  const recorded = fetches.splice(0);
  for (const fetchImpl of recorded) {
    for (const [input, init] of fetchImpl.mock.calls) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url.startsWith(`${baseUrl}/`)).toBe(true);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  }
});

export function fakeFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return await handler(url, init!);
  });
  fetches.push(fetchImpl);
  return fetchImpl;
}

export function bodyOf(fetchImpl: ReturnType<typeof fakeFetch>): Record<string, unknown> {
  return JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
}

interface Contract {
  id: string;
  create: (options: LocalHttpOptions) => Backend;
  success: string;
  partial: string;
  serverError: string;
  malformed: string;
  models: unknown;
  missing: unknown;
  availabilityPath: string;
}

export function localContract(config: Contract): void {
  describe(`${config.id} transport contract`, () => {
    afterEach(() => vi.useRealTimers());
    const create = (fetchImpl: typeof fetch, extra: Partial<LocalHttpOptions> = {}) =>
      config.create({ baseUrl, model: 'test', fetchImpl, ...extra });

    it('returns raw middle text across byte boundaries', async () => {
      const fetchImpl = fakeFetch(() => stream(config.success));
      const backend = create(fetchImpl);
      expect(await backend.complete(request())).toBe('  é中\n');
      expect(backend.id).toBe(config.id);
      expect(backend.kind).toBe('fim');
      backend.dispose();
    });

    it.each([
      ['HTTP error', () => stream('PREFIX_SECRET SUFFIX_SECRET HTTP_BODY_SECRET', 500), 'HTTP 500'],
      ['server error', () => stream(config.serverError), 'server error'],
      ['malformed response', () => stream(config.malformed), 'malformed response'],
      ['cut-off stream', () => stream(config.partial), 'stream ended early'],
      [
        'fetch exception',
        () => {
          throw new Error('PREFIX_SECRET SUFFIX_SECRET FETCH_SECRET');
        },
        'request failed',
      ],
      ['missing body', () => new Response(null), 'request failed'],
      [
        'body read error',
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error('PREFIX_SECRET'));
              },
            }),
          ),
        'request failed',
      ],
    ] as const)('sanitizes %s', async (_name, response, category) => {
      const backend = create(fakeFetch(response));
      await expect(backend.complete(request())).rejects.toThrow(`${config.id}: ${category}`);
      const error: unknown = await backend.complete(request()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`${config.id}: ${category}`);
      backend.dispose();
    });

    it('aborts a pending fetch promptly', async () => {
      let signal: AbortSignal | undefined;
      const backend = create(
        fakeFetch((_url, init) => {
          signal = init.signal!;
          return new Promise<Response>(() => {});
        }),
      );
      const controller = new AbortController();
      const result = backend.complete({ ...request(), signal: controller.signal });
      controller.abort('PREFIX_SECRET');
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(signal?.aborted).toBe(true);
      backend.dispose();
    });

    it('does not fetch for a pre-aborted request', async () => {
      const fetchImpl = fakeFetch(() => stream(config.success));
      const backend = create(fetchImpl);
      await expect(
        backend.complete({ ...request(), signal: AbortSignal.abort('PREFIX_SECRET') }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchImpl).not.toHaveBeenCalled();
      backend.dispose();
    });

    it('aborts while waiting for stream data', async () => {
      let signal: AbortSignal | undefined;
      const backend = create(
        fakeFetch((_url, init) => {
          signal = init.signal!;
          return new Response(new ReadableStream({ start() {} }));
        }),
      );
      const controller = new AbortController();
      const result = backend.complete({ ...request(), signal: controller.signal });
      await Promise.resolve();
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      expect(signal?.aborted).toBe(true);
      backend.dispose();
    });

    it.each([undefined, 25])('times out and aborts (timeoutMs=%s)', async (timeoutMs) => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const backend = create(
        fakeFetch((_url, init) => {
          signal = init.signal!;
          return new Promise<Response>(() => {});
        }),
        { timeoutMs },
      );
      const result = backend.complete(request());
      const assertion = expect(result).rejects.toThrow(`${config.id}: timeout`);
      await vi.advanceTimersByTimeAsync(timeoutMs ?? 10_000);
      await assertion;
      expect(signal?.aborted).toBe(true);
      backend.dispose();
    });

    it('dispose aborts every request and availability check and refuses further calls', async () => {
      const signals: AbortSignal[] = [];
      const fetchImpl = fakeFetch((_url, init) => {
        signals.push(init.signal!);
        return new Promise<Response>(() => {});
      });
      const backend = create(fetchImpl);
      const first = backend.complete(request());
      const second = backend.complete(request());
      const available = backend.isAvailable();
      backend.dispose();
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await expect(second).rejects.toMatchObject({ name: 'AbortError' });
      expect(await available).toBe(false);
      expect(signals).toHaveLength(3);
      expect(signals.every((s) => s.aborted)).toBe(true);
      await expect(backend.complete(request())).rejects.toThrow(`${config.id}: disposed`);
      expect(await backend.isAvailable()).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['listed', config.models, true],
      ['missing', config.missing, false],
      ['malformed', null, false],
    ] as const)('availability checks model: %s', async (_name, payload, expected) => {
      const fetchImpl = fakeFetch(() => Response.json(payload));
      const backend = create(fetchImpl);
      expect(await backend.isAvailable()).toBe(expected);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${baseUrl}${config.availabilityPath}`);
      expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');
      backend.dispose();
    });

    it('shares concurrent checks and caches for 30 seconds', async () => {
      vi.useFakeTimers();
      const fetchImpl = fakeFetch(() => Response.json(config.models));
      const backend = create(fetchImpl);
      expect(await Promise.all([backend.isAvailable(), backend.isAvailable()])).toEqual([
        true,
        true,
      ]);
      expect(await backend.isAvailable()).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(await backend.isAvailable()).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await backend.isAvailable()).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      backend.dispose();
    });

    it.each(['unreachable', 'HTTP error', 'bad JSON'])(
      'availability never throws: %s',
      async (failure) => {
        const backend = create(
          fakeFetch(() => {
            if (failure === 'unreachable') throw new Error('PREFIX_SECRET');
            return stream('PREFIX_SECRET', failure === 'HTTP error' ? 500 : 200);
          }),
        );
        expect(await backend.isAvailable()).toBe(false);
        expect(await backend.isAvailable()).toBe(false);
        backend.dispose();
      },
    );

    it('availability times out after two seconds', async () => {
      vi.useFakeTimers();
      let signal: AbortSignal | undefined;
      const backend = create(
        fakeFetch((_url, init) => {
          signal = init.signal!;
          return new Promise<Response>(() => {});
        }),
      );
      const result = backend.isAvailable();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await result).toBe(false);
      expect(signal?.aborted).toBe(true);
      backend.dispose();
    });

    it('run rejects on its first next()', async () => {
      const backend = create(fakeFetch(() => stream(config.success)));
      const iterable = backend.run('unused', { signal: request().signal });
      await expect(iterable[Symbol.asyncIterator]().next()).rejects.toThrow(
        `${config.id} is a fill-in-the-middle backend; chat is not supported`,
      );
      backend.dispose();
    });

    it.each([
      'file:///tmp/model',
      'ftp://localhost',
      'not a URL',
      'data:text/plain,secret',
      'http://localhost:1234/?',
      'http://localhost:1234/#',
      'http://user:password@localhost:1234/',
      'http://localhost:1234/?key=value',
      'http://localhost:1234/#fragment',
      'http://user@localhost:1234/',
      'http://:password@localhost:1234/',
    ])('rejects invalid base URL %s', (url) => {
      expect(() => config.create({ baseUrl: url, model: 'test' })).toThrow(
        `${config.id}: invalid base URL`,
      );
    });
  });
}
