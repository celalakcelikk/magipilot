// ClaudeCliBackend / CodexCliBackend against the fake CLI (test/fixtures/fake-cli/fake-cli.mjs).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCliBackend, type ClaudeCliOptions } from '../../src/core/backends/claudeCli';
import { CodexCliBackend } from '../../src/core/backends/codexCli';
import { failureMessage } from '../../src/core/backends/failures';
import type { CompletionRequest } from '../../src/core/backends/types';
import { isGroupAlive, ProcessRegistry, sleep } from '../../src/core/process/runner';

const FAKE = resolve(__dirname, '../fixtures/fake-cli/fake-cli.mjs');

interface LogEntry {
  pid: number;
  args: string[];
  cwd: string;
  cwdEntries: string[];
  stdinEnded: boolean;
  stdinChars: number;
  answered: boolean;
}

let logDir: string;
let logFile: string;
let registry: ProcessRegistry;
const backends: { dispose(): void }[] = [];

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'magipilot-fake-log-'));
  logFile = join(logDir, 'log.jsonl');
  process.env.FAKE_CLI_LOG = logFile;
  process.env.FAKE_CLI_MODE = 'ok';
  delete process.env.FAKE_CLI_TEXT;
  registry = new ProcessRegistry();
});

afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
  registry.dispose();
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.FAKE_CLI_LOG;
  delete process.env.FAKE_CLI_MODE;
});

function entries(): LogEntry[] {
  try {
    return readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  } catch {
    return [];
  }
}

function request(signal: AbortSignal = new AbortController().signal): CompletionRequest {
  return {
    prefix: 'function add(a: number, b: number) {\n  return ',
    suffix: '\n}\n',
    languageId: 'typescript',
    filePath: 'src/add.ts',
    snippets: [],
    maxTokens: 64,
    signal,
  };
}

function claude(overrides: Partial<ClaudeCliOptions> = {}): ClaudeCliBackend {
  const backend = new ClaudeCliBackend({
    path: FAKE,
    model: 'haiku',
    effort: 'low',
    warmPoolSize: 0,
    disableNonessentialTraffic: true,
    timeoutMs: 10_000,
    processes: registry,
    ...overrides,
  });
  backends.push(backend);
  return backend;
}

function codex(timeoutMs = 10_000): CodexCliBackend {
  const backend = new CodexCliBackend({
    path: FAKE,
    model: 'gpt-6-luna',
    effort: 'low',
    timeoutMs,
    processes: registry,
  });
  backends.push(backend);
  return backend;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not reached');
    await sleep(20);
  }
}

describe('ClaudeCliBackend (fake CLI)', () => {
  it('cold: returns the raw text; isolated args, empty temp cwd, stdin closed', async () => {
    expect(await claude().complete(request())).toBe('a + b;');
    const [entry] = entries();
    expect(entry!.stdinEnded).toBe(true);
    expect(entry!.cwdEntries).toEqual([]);
    expect(entry!.cwd).not.toBe(process.cwd());
    const args = entry!.args;
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    for (const flag of ['-p', '--no-session-persistence', '--safe-mode', '--strict-mcp-config']) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(registry.leakedPids()).toEqual([]);
  });

  it('warm: uses a pre-started stream-json process and starts a replacement', async () => {
    const backend = claude({ warmPoolSize: 1 });
    backend.prime();
    await sleep(300);
    expect(await backend.complete(request())).toBe('a + b;');
    const used = entries().find((e) => e.answered)!;
    expect(used.args).toContain('--input-format');
    await waitFor(() => entries().some((e) => e.pid === used.pid && e.stdinEnded));
    // The replacement spare is alive and waiting; dispose stops it.
    expect(registry.startedCount).toBe(2);
    backend.dispose();
    await waitFor(() => registry.leakedPids().length === 0);
  });

  it('rejects on timeout and kills the process', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const startedAt = Date.now();
    await expect(claude({ timeoutMs: 400 }).complete(request())).rejects.toMatchObject({
      kind: 'timeout',
    });
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(registry.leakedPids()).toEqual([]);
  });

  it('warm: rejects on timeout and kills the process', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const backend = claude({ warmPoolSize: 1, timeoutMs: 400 });
    await expect(backend.complete(request())).rejects.toMatchObject({ kind: 'timeout' });
    const hung = entries()[0]!;
    await waitFor(() => !isGroupAlive(hung.pid));
  });

  it('a non-zero exit after a result event is a failure (Faz 0 P0-R2-001)', async () => {
    process.env.FAKE_CLI_MODE = 'exit-after-result';
    await expect(claude().complete(request())).rejects.toMatchObject({
      kind: 'other',
      detail: 'exit 3',
    });
  });

  it('an error result is a failure', async () => {
    process.env.FAKE_CLI_MODE = 'error-result';
    await expect(claude().complete(request())).rejects.toMatchObject({
      kind: 'other',
      message: failureMessage('claude', 'other'),
    });
  });

  for (const warmPoolSize of [0, 1]) {
    it(`abort kills the process (warmPoolSize ${warmPoolSize})`, async () => {
      process.env.FAKE_CLI_MODE = 'hang';
      const controller = new AbortController();
      const pending = claude({ warmPoolSize }).complete(request(controller.signal));
      await waitFor(() => entries().length > 0);
      const pid = entries()[0]!.pid;
      controller.abort();
      await expect(pending).rejects.toThrow(/aborted/);
      await waitFor(() => !isGroupAlive(pid));
    });
  }

  it('an already aborted request never spawns', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(claude().complete(request(controller.signal))).rejects.toThrow(/aborted/);
    expect(registry.startedCount).toBe(0);
  });

  it('run() streams text deltas', async () => {
    process.env.FAKE_CLI_TEXT = 'hello world';
    const chunks: string[] = [];
    for await (const chunk of claude().run('hi', { signal: new AbortController().signal })) {
      chunks.push(chunk);
    }
    expect(chunks.join('')).toBe('hello world');
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('isAvailable() reflects whether the executable runs', async () => {
    expect(await claude().isAvailable()).toBe(true);
    expect(await claude({ path: join(logDir, 'missing-claude') }).isAvailable()).toBe(false);
  });

  it('isAvailable() runs --version tracked by the registry, in an empty temp dir (P1-I004)', async () => {
    const backend = claude();
    const [first, second] = await Promise.all([backend.isAvailable(), backend.isAvailable()]);
    expect(first && second).toBe(true);
    expect(registry.startedCount).toBe(1); // concurrent checks share one probe
    const [entry] = entries();
    expect(entry!.args).toEqual(['--version']);
    expect(entry!.cwdEntries).toEqual([]);
    expect(entry!.cwd).not.toBe(process.cwd());
  });

  it('warm: an abort right after the call still stops the process taken from the pool (P1-I001)', async () => {
    const backend = claude({ warmPoolSize: 1 });
    backend.prime();
    await sleep(200);
    const controller = new AbortController();
    const pending = backend.complete(request(controller.signal));
    controller.abort(); // before the prompt is written
    await expect(pending).rejects.toThrow(/aborted/);
    // Only the replacement spare may be alive; the taken one is gone.
    await waitFor(() => registry.leakedPids().length === 1);
    backend.dispose();
    await waitFor(() => registry.leakedPids().length === 0);
  });

  it('warm: an abort while waiting for the idle minimum stops the taken process (P1-I001)', async () => {
    const backend = claude({ warmPoolSize: 1, warmPoolMinIdleMs: 1000 });
    const controller = new AbortController();
    const pending = backend.complete(request(controller.signal));
    await sleep(100);
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await waitFor(() => registry.leakedPids().length === 1);
    expect(entries().filter((e) => e.answered)).toEqual([]);
  });

  for (const warmPoolSize of [0, 1]) {
    it(`dispose() aborts a running request and refuses new ones (warmPoolSize ${warmPoolSize}, P1-I003)`, async () => {
      process.env.FAKE_CLI_MODE = 'hang';
      const backend = claude({ warmPoolSize });
      const pending = backend.complete(request());
      await waitFor(() => entries().some((e) => e.stdinChars > 0));
      const pid = entries().find((e) => e.stdinChars > 0)!.pid;
      backend.dispose();
      await expect(pending).rejects.toThrow(/aborted/);
      await waitFor(() => !isGroupAlive(pid));
      await expect(backend.complete(request())).rejects.toThrow(/disposed/);
      expect(await backend.isAvailable()).toBe(false);
      await waitFor(() => registry.leakedPids().length === 0);
    });
  }

  it('run(): a consumer that stops early kills the CLI', async () => {
    process.env.FAKE_CLI_TEXT = 'hello world';
    process.env.FAKE_CLI_MODE = 'ok';
    const iterator = claude().run('hi', { signal: new AbortController().signal });
    for await (const chunk of iterator) {
      expect(chunk).toBeTruthy();
      break;
    }
    await waitFor(() => registry.leakedPids().length === 0);
  });

  it('sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC only when enabled', () => {
    // Checked on the env the backend passes to spawn (private method).
    const backend = claude();
    expect((backend as unknown as { env(): NodeJS.ProcessEnv }).env()).toMatchObject({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });
    const off = claude({ disableNonessentialTraffic: false });
    expect(
      (off as unknown as { env(): NodeJS.ProcessEnv }).env()
        .CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    ).toBe(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
  });
});

describe('CLI error messages are content-free (docs/plans/phase-1-local.md C6, C-AC5)', () => {
  const MARKER = 'PROMPT_ECHO_7f3a';

  afterEach(() => {
    delete process.env.FAKE_CLI_MARKER;
  });

  async function rejection(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error('expected a rejection');
  }

  for (const warmPoolSize of [0, 1]) {
    it(`Claude: stderr of a failing CLI never reaches the error (warmPoolSize ${warmPoolSize})`, async () => {
      process.env.FAKE_CLI_MODE = 'exit-after-result';
      process.env.FAKE_CLI_MARKER = MARKER;
      const message = await rejection(claude({ warmPoolSize }).complete(request()));
      expect(message).toBe(failureMessage('claude', 'other'));
      expect(message).not.toContain(MARKER);
    });

    it(`Claude: an error result's subtype never reaches the error (warmPoolSize ${warmPoolSize}, C-R001)`, async () => {
      process.env.FAKE_CLI_MODE = 'error-result';
      process.env.FAKE_CLI_MARKER = MARKER;
      const message = await rejection(claude({ warmPoolSize }).complete(request()));
      expect(message).toBe(failureMessage('claude', 'other'));
    });
  }

  it('Codex: a failed turn and its stderr never reach the error', async () => {
    process.env.FAKE_CLI_MODE = 'fail-turn';
    process.env.FAKE_CLI_MARKER = MARKER;
    const message = await rejection(codex().complete(request()));
    expect(message).toBe(failureMessage('codex', 'other'));
    expect(message).not.toContain(MARKER);
  });
});

describe('CodexCliBackend (fake CLI)', () => {
  it('runs a structured turn: --output-schema next to -o, outside the empty root (phase-4-tools T2)', async () => {
    process.env.FAKE_CLI_STRUCTURED = JSON.stringify({
      message: '',
      tool_calls: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }],
    });
    try {
      const answer = await codex().runStructured('read it', {
        signal: new AbortController().signal,
      });
      expect(answer).toEqual({
        message: '',
        toolCalls: [{ name: 'read_file', arguments: '{"path":"a.ts"}' }],
      });
      const [entry] = entries() as (LogEntry & { schemaExists?: boolean; schemaInCwd?: boolean })[];
      expect(entry!.args).toContain('--output-schema');
      expect(entry!.args[entry!.args.indexOf('-s') + 1]).toBe('read-only');
      expect(entry!.schemaExists).toBe(true);
      expect(entry!.schemaInCwd).toBe(false);
      expect(entry!.cwdEntries).toEqual([]);
    } finally {
      delete process.env.FAKE_CLI_STRUCTURED;
    }
  });

  it('returns the final message; read-only sandbox, lean profile, stdin closed, empty cwd', async () => {
    expect(await codex().complete(request())).toBe('a + b;');
    const [entry] = entries();
    expect(entry!.stdinEnded).toBe(true);
    expect(entry!.stdinChars).toBeGreaterThan(0);
    expect(entry!.cwdEntries).toEqual([]);
    const args = entry!.args;
    expect(args[0]).toBe('exec');
    expect(args[args.indexOf('-s') + 1]).toBe('read-only');
    for (const flag of ['--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config']) {
      expect(args).toContain(flag);
    }
    expect(args.at(-1)).toBe('-');
  });

  it('rejects on timeout and kills the process', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    await expect(codex(400).complete(request())).rejects.toMatchObject({ kind: 'timeout' });
    expect(registry.leakedPids()).toEqual([]);
  });

  it('a failed turn is a failure', async () => {
    process.env.FAKE_CLI_MODE = 'fail-turn';
    await expect(codex().complete(request())).rejects.toMatchObject({ kind: 'other' });
  });

  it('dispose() aborts a running call and refuses new ones (P1-I003)', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const backend = codex();
    const pending = backend.complete(request());
    await waitFor(() => entries().length > 0);
    const pid = entries()[0]!.pid;
    backend.dispose();
    await expect(pending).rejects.toThrow(/aborted/);
    await waitFor(() => !isGroupAlive(pid));
    await expect(backend.complete(request())).rejects.toThrow(/disposed/);
  });

  it('isAvailable() runs --version tracked, in an empty temp dir (P1-I004)', async () => {
    expect(await codex().isAvailable()).toBe(true);
    expect(registry.startedCount).toBe(1);
    expect(entries()[0]!.cwdEntries).toEqual([]);
  });

  it('abort kills the process', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const controller = new AbortController();
    const pending = codex().complete(request(controller.signal));
    await waitFor(() => entries().length > 0);
    const pid = entries()[0]!.pid;
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    await waitFor(() => !isGroupAlive(pid));
  });
});

describe('classified failures and their precedence (phase-3-errors §3 step 3, E6)', () => {
  async function failureOf(
    run: () => Promise<unknown>,
  ): Promise<{ kind: string; message: string }> {
    try {
      await run();
    } catch (err) {
      return err as { kind: string; message: string };
    }
    throw new Error('expected a rejection');
  }
  const drain = async (iterable: AsyncIterable<string>): Promise<void> => {
    for await (const _chunk of iterable) {
      /* drain */
    }
  };

  // Each mode classifies the failure and then exits 1: the classification wins over the exit.
  for (const [mode, kind] of [
    ['auth', 'not-logged-in'],
    ['limit', 'limit'],
  ] as const) {
    for (const warmPoolSize of [0, 1]) {
      it(`Claude complete, warmPoolSize ${warmPoolSize}: ${mode} then exit 1 is ${kind}`, async () => {
        process.env.FAKE_CLI_MODE = mode;
        const failure = await failureOf(() => claude({ warmPoolSize }).complete(request()));
        expect(failure.kind).toBe(kind);
        expect(failure.message).toBe(failureMessage('claude', kind));
      });
    }

    it(`Claude chat (run): ${mode} then exit 1 is ${kind}`, async () => {
      process.env.FAKE_CLI_MODE = mode;
      const failure = await failureOf(() =>
        drain(claude().run('hi', { signal: new AbortController().signal })),
      );
      expect(failure.kind).toBe(kind);
    });

    it(`Codex exec: ${mode} then exit 1 is ${kind}`, async () => {
      process.env.FAKE_CLI_MODE = mode;
      const failure = await failureOf(() => codex().complete(request()));
      expect(failure.kind).toBe(kind);
      expect(failure.message).toBe(failureMessage('codex', kind));
    });
  }

  it('a successful turn followed by an abnormal exit stays other (P0-R2-001)', async () => {
    process.env.FAKE_CLI_MODE = 'exit-after-result';
    expect((await failureOf(() => codex().complete(request()))).kind).toBe('other');
    expect((await failureOf(() => claude().complete(request()))).kind).toBe('other');
    expect(
      (await failureOf(() => drain(claude().run('hi', { signal: new AbortController().signal }))))
        .kind,
    ).toBe('other');
  });
});
