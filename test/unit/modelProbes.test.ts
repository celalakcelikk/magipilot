// The model probes against the fake CLI (docs/plans/phase-4-models.md M3).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProcessRegistry } from '../../src/core/process/runner';
import {
  probeClaudeModels,
  probeClaudeWindow,
  probeCodexModels,
} from '../../src/features/chat/modelProbes';

const FAKE = resolve(__dirname, '../fixtures/fake-cli/fake-cli.mjs');

interface LogEntry {
  args: string[];
  cwd: string;
  cwdEntries: string[];
  initialized?: boolean;
  nonessential?: string | null;
  catalog?: boolean;
  hung?: boolean;
  event?: string;
  userMessage?: boolean;
  windowAsked?: string;
}

let logDir: string;
let logFile: string;
let registry: ProcessRegistry;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'magipilot-fake-log-'));
  logFile = join(logDir, 'log.jsonl');
  process.env.FAKE_CLI_LOG = logFile;
  process.env.FAKE_CLI_MODE = 'ok';
  process.env.FAKE_CLI_MODELS = '1';
  registry = new ProcessRegistry();
});

afterEach(() => {
  registry.dispose();
  rmSync(logDir, { recursive: true, force: true });
  delete process.env.FAKE_CLI_LOG;
  delete process.env.FAKE_CLI_MODE;
  delete process.env.FAKE_CLI_MODELS;
  delete process.env.FAKE_CLI_WINDOWS;
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

describe('probeClaudeModels (M3)', () => {
  it('asks with initialize in an empty folder and sends no user message', async () => {
    const models = await probeClaudeModels(registry, FAKE, { disableNonessentialTraffic: true });
    expect(Array.isArray(models) && models.map((m) => m.id)).toContain('sonnet');
    const all = entries();
    const asked = all.find((e) => e.initialized)!;
    expect(asked.args).toEqual([
      '-p',
      '--tools',
      '',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--no-session-persistence',
      '--safe-mode',
      '--strict-mcp-config',
      '--setting-sources',
      '',
    ]);
    expect(asked.cwdEntries).toEqual([]);
    expect(existsSync(asked.cwd)).toBe(false);
    // stdin closed after the answer, without a user message, and the CLI did not answer one.
    const end = all.find((e) => e.event === 'stdin-end')!;
    expect(end.userMessage).toBe(false);
    expect(all.some((e) => (e as { answered?: boolean }).answered === true)).toBe(false);
  });

  it('follows magipilot.claude.disableNonessentialTraffic (P4M-R002)', async () => {
    await probeClaudeModels(registry, FAKE, { disableNonessentialTraffic: true });
    await probeClaudeModels(registry, FAKE, { disableNonessentialTraffic: false });
    const asked = entries().filter((e) => e.initialized);
    expect(asked.map((e) => e.nonessential)).toEqual(['1', null]);
  });

  it('does not accept an answer when the CLI then fails (P4M-I003)', async () => {
    process.env.FAKE_CLI_MODE = 'exit-after-result';
    expect(await probeClaudeModels(registry, FAKE)).toBe('exit');
    expect(entries().some((e) => e.initialized)).toBe(true);
  });

  it('reports an answer without models, a hang, and a missing executable', async () => {
    delete process.env.FAKE_CLI_MODELS;
    expect(await probeClaudeModels(registry, FAKE)).toBe('no-models');
    process.env.FAKE_CLI_MODE = 'hang';
    const started = Date.now();
    expect(await probeClaudeModels(registry, FAKE, { timeoutMs: 500 })).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await probeClaudeModels(registry, join(logDir, 'no-such-cli'))).toBe('not-installed');
  });
});

describe('probeCodexModels (M3)', () => {
  it('reads the catalog of debug models, with stdin closed, in an empty folder', async () => {
    const models = await probeCodexModels(registry, FAKE);
    expect(Array.isArray(models) && models.map((m) => m.id)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6.1-terra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    const [asked] = entries().filter((e) => e.catalog);
    expect(asked!.args).toEqual(['debug', 'models']);
    expect(asked!.cwdEntries).toEqual([]);
    expect(existsSync(asked!.cwd)).toBe(false);
  });

  it('reports an empty catalog, a hang, and a missing executable', async () => {
    delete process.env.FAKE_CLI_MODELS;
    expect(await probeCodexModels(registry, FAKE)).toBe('no-models');
    process.env.FAKE_CLI_MODE = 'hang';
    expect(await probeCodexModels(registry, FAKE, { timeoutMs: 500 })).toBe('timeout');
    expect(await probeCodexModels(registry, join(logDir, 'no-such-cli'))).toBe('not-installed');
  });
});

describe('probeClaudeWindow (phase-4-context.md W1)', () => {
  it('starts with --model, asks initialize and get_context_usage, and sends no user message', async () => {
    expect(
      await probeClaudeWindow(registry, FAKE, 'sonnet', { disableNonessentialTraffic: true }),
    ).toBe(1_000_000);
    const all = entries();
    const asked = all.find((e) => e.windowAsked)!;
    expect(asked.windowAsked).toBe('sonnet');
    expect(asked.nonessential).toBe('1');
    // The model probe's isolation set, with the model chosen at start (never set_model, D3).
    expect(asked.args).toEqual([
      '--model',
      'sonnet',
      '-p',
      '--tools',
      '',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'stream-json',
      '--no-session-persistence',
      '--safe-mode',
      '--strict-mcp-config',
      '--setting-sources',
      '',
    ]);
    expect(asked.cwdEntries).toEqual([]);
    expect(existsSync(asked.cwd)).toBe(false);
    const end = all.find((e) => e.event === 'stdin-end')!;
    expect(end.userMessage).toBe(false);
    expect(all.some((e) => (e as { answered?: boolean }).answered === true)).toBe(false);
  });

  it("reads each model's own window", async () => {
    expect(await probeClaudeWindow(registry, FAKE, 'claude-opus-4-6')).toBe(200_000);
    process.env.FAKE_CLI_WINDOWS = JSON.stringify({ opus: 64_000 });
    expect(await probeClaudeWindow(registry, FAKE, 'opus')).toBe(64_000);
  });

  it('gives no window for an unusable answer, a failed exit, a hang or a bad id', async () => {
    process.env.FAKE_CLI_WINDOWS = JSON.stringify({ opus: 63_999, sonnet: 'many' });
    expect(await probeClaudeWindow(registry, FAKE, 'opus')).toBe('unreadable');
    expect(await probeClaudeWindow(registry, FAKE, 'sonnet')).toBe('unreadable');
    delete process.env.FAKE_CLI_WINDOWS;
    process.env.FAKE_CLI_MODE = 'exit-after-result';
    expect(await probeClaudeWindow(registry, FAKE, 'haiku')).toBe('exit');
    process.env.FAKE_CLI_MODE = 'hang';
    expect(await probeClaudeWindow(registry, FAKE, 'haiku', { timeoutMs: 500 })).toBe('timeout');
    process.env.FAKE_CLI_MODE = 'ok';
    const before = entries().length;
    expect(await probeClaudeWindow(registry, FAKE, '--model x')).toBe('unreadable');
    expect(entries()).toHaveLength(before);
    expect(await probeClaudeWindow(registry, join(logDir, 'no-such-cli'), 'opus')).toBe(
      'not-installed',
    );
  });
});
