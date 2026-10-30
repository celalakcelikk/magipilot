import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ollamaGenerate } from '../../scripts/bench/clients/ollama';
import { openAiComplete } from '../../scripts/bench/clients/openaiCompat';

// A local stand-in server: each path returns a fixed (complete or truncated) stream.
const routes: Record<string, string> = {
  '/complete/api/generate': [
    JSON.stringify({ response: 'return ', done: false }),
    JSON.stringify({ response: 'x', done: false }),
    JSON.stringify({ response: '', done: true, load_duration: 2_000_000, eval_count: 2 }),
  ].join('\n'),
  '/truncated/api/generate': `${JSON.stringify({ response: 'ret', done: false })}\n`,
  '/complete/v1/completions': [
    `data: ${JSON.stringify({ choices: [{ text: 'return x', finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ text: '', finish_reason: 'stop' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n'),
  '/done-only/v1/completions': [
    `data: ${JSON.stringify({ choices: [{ text: 'return x' }] })}`,
    'data: [DONE]',
    '',
  ].join('\n\n'),
  '/truncated/v1/completions': `data: ${JSON.stringify({ choices: [{ text: 'ret' }] })}\n\n`,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = routes[req.url ?? ''];
    if (body === undefined) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ollamaOptions = {
  model: 'm',
  prompt: 'p',
  numPredict: 8,
  temperature: 0.2,
  keepAlive: 0,
  timeoutMs: 5000,
};
const openAiOptions = {
  model: 'm',
  prompt: 'p',
  suffix: 's',
  maxTokens: 8,
  temperature: 0.2,
  timeoutMs: 5000,
};

describe('ollamaGenerate (review P0-I010)', () => {
  it('succeeds only when the stream ends with done=true', async () => {
    const result = await ollamaGenerate({ ...ollamaOptions, baseUrl: `${base}/complete` });
    expect(result).toMatchObject({ ok: true, text: 'return x', loadMs: 2 });
  });

  it('treats a stream cut off before done=true as an error, keeping the partial text', async () => {
    const result = await ollamaGenerate({ ...ollamaOptions, baseUrl: `${base}/truncated` });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('done=true');
    expect(result.text).toBe('ret');
  });

  it('reports HTTP errors', async () => {
    const result = await ollamaGenerate({ ...ollamaOptions, baseUrl: `${base}/missing` });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 404');
  });
});

describe('openAiComplete (review P0-I010)', () => {
  it('succeeds with a finish_reason and [DONE]', async () => {
    const result = await openAiComplete({ ...openAiOptions, baseUrl: `${base}/complete` });
    expect(result).toMatchObject({ ok: true, text: 'return x' });
  });

  it('accepts [DONE] alone as the completion marker', async () => {
    const result = await openAiComplete({ ...openAiOptions, baseUrl: `${base}/done-only` });
    expect(result.ok).toBe(true);
  });

  it('treats a stream without finish_reason or [DONE] as an error', async () => {
    const result = await openAiComplete({ ...openAiOptions, baseUrl: `${base}/truncated` });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('[DONE]');
    expect(result.text).toBe('ret');
  });
});
