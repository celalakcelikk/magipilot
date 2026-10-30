// Per-model windows and budgets, the vendors, and the Codex window argument
// (docs/plans/phase-4-context.md G1, G2, W3–W6).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeModelProbeArgs,
  buildCodexArgs,
  claudeContextUsageRequest,
} from '../../src/core/process/cliArgs';
import {
  codexModelsFromCatalog,
  sanitizeStored,
  ModelDiscovery,
} from '../../src/features/chat/modelDiscovery';
import {
  chatModels,
  CONVERSION_RESERVE,
  maxInputTokens,
  migratedUtilityValue,
  modelWindow,
  promptBudget,
  requestBudget,
  vendorOf,
} from '../../src/features/chat/models';

const GATES = {
  trusted: true,
  platform: 'darwin' as NodeJS.Platform,
  claudeAvailable: true,
  codexAvailable: true,
};
const CATALOG = readFileSync(resolve(__dirname, '../fixtures/codex/models.json'), 'utf8');

describe('per-model numbers (W3)', () => {
  it.each([
    // backend, window, maxInputTokens
    ['claude-cli', 1_000_000, 1_000_000 - 32_000 - 2_000 - 4_000],
    ['claude-cli', 200_000, 162_000],
    ['codex-cli', 272_000, Math.floor(272_000 * 0.95) - 16_000 - 12_000 - 4_000],
    ['codex-cli', 500_000, 475_000 - 32_000],
    ['codex-cli', 872_000, Math.floor(872_000 * 0.95) - 32_000],
  ] as const)('%s with a %i window', (backend, window, expected) => {
    expect(maxInputTokens(backend, window)).toBe(expected);
    expect(promptBudget(backend, window)).toBe(expected + CONVERSION_RESERVE);
  });

  it("keeps Codex's whole prompt within its 1 048 576-character input limit", () => {
    // A 2M window would give 1 872 000; Codex refuses more than 1 048 576 characters.
    expect(promptBudget('codex-cli', 2_000_000)).toBe(1_048_576);
    expect(maxInputTokens('codex-cli', 2_000_000)).toBe(1_048_576 - CONVERSION_RESERVE);
    // The largest catalog window today stays below it.
    expect(promptBudget('codex-cli', 872_000)).toBeLessThan(1_048_576);
    expect(promptBudget('claude-cli', 2_000_000)).toBe(2_000_000 - 34_000);
  });

  it('stays positive at the smallest window (P4CTX-R001)', () => {
    expect(maxInputTokens('claude-cli', 64_000)).toBe(26_000);
    expect(maxInputTokens('codex-cli', 64_000)).toBe(28_800);
  });

  it('takes the read or catalog window, the cap, and the opt-in for Codex', () => {
    const none = {};
    expect(modelWindow('claude-cli', { id: 'opus', contextWindow: 1_000_000 }, none)).toEqual({
      window: 1_000_000,
    });
    // No window: the CLI's assumed one; a window below the floor counts as none.
    expect(modelWindow('claude-cli', { id: 'x' }, none)).toEqual({ window: 200_000 });
    expect(modelWindow('claude-cli', { id: 'x', contextWindow: 63_999 }, none)).toEqual({
      window: 200_000,
    });
    expect(modelWindow('codex-cli', { id: 'x' }, none)).toEqual({ window: 128_000 });
    const luna = { id: 'gpt-6-luna', contextWindow: 272_000, maxContextWindow: 872_000 };
    expect(modelWindow('codex-cli', luna, none)).toEqual({ window: 272_000 });
    expect(modelWindow('codex-cli', luna, { codexMaxWindow: true })).toEqual({
      window: 872_000,
      cli: 872_000,
    });
    // The cap applies after the opt-in; the argument follows the window used.
    expect(modelWindow('codex-cli', luna, { codexMaxWindow: true, windowLimit: 400_000 })).toEqual({
      window: 400_000,
      cli: 400_000,
    });
    expect(modelWindow('codex-cli', luna, { codexMaxWindow: true, windowLimit: 200_000 })).toEqual({
      window: 200_000,
    });
    // The opt-in is Codex's only.
    expect(
      modelWindow(
        'claude-cli',
        { id: 'opus', contextWindow: 200_000, maxContextWindow: 1_000_000 },
        {
          codexMaxWindow: true,
        },
      ),
    ).toEqual({ window: 200_000 });
  });

  it('accepts a cap from 64 000 to 2 000 000 only (W4)', () => {
    const opus = { id: 'opus', contextWindow: 1_000_000 };
    expect(modelWindow('claude-cli', opus, { windowLimit: 64_000 })).toEqual({ window: 64_000 });
    expect(
      maxInputTokens('claude-cli', modelWindow('claude-cli', opus, { windowLimit: 64_000 }).window),
    ).toBe(26_000);
    for (const bad of [63_999, 2_000_001, 100_000.5, null, undefined]) {
      expect(modelWindow('claude-cli', opus, { windowLimit: bad }), String(bad)).toEqual({
        window: 1_000_000,
      });
    }
  });

  it('builds descriptors with the window, the budget, the vendor and the Codex argument', () => {
    const models = chatModels(
      {
        claudeModels: [
          { id: 'opus', displayName: 'Opus 5.5', contextWindow: 1_000_000 },
          { id: 'claude-opus-4-6', displayName: 'Opus 4.6', contextWindow: 200_000 },
        ],
        codexModels: codexModelsFromCatalog(CATALOG)!,
        codexMaxWindow: true,
      },
      GATES,
    );
    const byId = new Map(models.map((m) => [m.id, m]));
    // The advertised size is what Copilot can use: input plus output (phase-4-picker.md U6).
    expect(byId.get('claude-cli.opus')).toMatchObject({
      vendor: 'magipilot',
      detail: '1M',
      maxContextWindowTokens: 994_000,
      maxInputTokens: 962_000,
    });
    expect(byId.get('claude-cli.opus')!.cliContextWindow).toBeUndefined();
    expect(byId.get('claude-cli.claude-opus-4-6')).toMatchObject({
      detail: '194K',
      maxInputTokens: 162_000,
    });
    expect(byId.get('codex-cli.gpt-6-luna')).toMatchObject({
      vendor: 'magipilot-codex',
      detail: '812K',
      maxContextWindowTokens: 812_400,
      // Codex itself gets its whole window.
      cliContextWindow: 872_000,
      maxInputTokens: Math.floor(872_000 * 0.95) - 32_000,
    });
    const off = chatModels(
      { claudeModels: [], codexModels: codexModelsFromCatalog(CATALOG)! },
      GATES,
    );
    expect(off.find((m) => m.id === 'codex-cli.gpt-6-luna')).toMatchObject({
      detail: '242K',
      maxContextWindowTokens: 242_400,
    });
    expect(off.find((m) => m.id === 'codex-cli.gpt-6.1-sol')!.maxContextWindowTokens).toBe(459_000);
    expect(off.every((m) => m.cliContextWindow === undefined)).toBe(true);
  });

  it("uses the requested model's own budget for the size gate", () => {
    expect(requestBudget('claude-cli', 962_000)).toBe(966_000);
    // Unusable: the CLI's default.
    for (const bad of [undefined, 0, -5, 1.5, '962000']) {
      expect(requestBudget('claude-cli', bad)).toBe(promptBudget('claude-cli'));
    }
  });
});

describe('vendors and identifiers (G1, G2)', () => {
  it('keeps Claude on magipilot and gives Codex its own vendor', () => {
    expect(vendorOf('claude-cli')).toBe('magipilot');
    expect(vendorOf('codex-cli')).toBe('magipilot-codex');
  });

  it('maps only the old Codex values', () => {
    expect(migratedUtilityValue('magipilot/codex-cli.gpt-6-luna')).toBe(
      'magipilot-codex/codex-cli.gpt-6-luna',
    );
    for (const other of [
      'magipilot/claude-cli.haiku',
      'magipilot-codex/codex-cli.gpt-6-luna',
      'copilot/gpt-6',
      'magipilot/codex-cli.bad id',
      'magipilot/codex-cli.',
      undefined,
      42,
    ]) {
      expect(migratedUtilityValue(other), String(other)).toBeUndefined();
    }
  });
});

describe('Codex window argument and catalog (W5, W6)', () => {
  const base = {
    model: 'gpt-6-luna',
    effort: 'low' as const,
    cwd: '/tmp/x',
    lastMessagePath: '/tmp/o',
  };

  it('adds model_context_window only with a window', () => {
    expect(buildCodexArgs(base).join(' ')).not.toContain('model_context_window');
    const args = buildCodexArgs({ ...base, contextWindow: 872_000 });
    const at = args.indexOf('model_context_window=872000');
    expect(at).toBeGreaterThan(0);
    expect(args[at - 1]).toBe('-c');
  });

  it('reads max_context_window, with the floor, and keeps it through the store', () => {
    const models = codexModelsFromCatalog(CATALOG)!;
    expect(models.find((m) => m.id === 'gpt-6-luna')).toMatchObject({
      contextWindow: 272_000,
      maxContextWindow: 872_000,
    });
    expect(sanitizeStored(JSON.parse(JSON.stringify(models)) as unknown, 'codex')).toEqual(models);
    const [small] = codexModelsFromCatalog(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-x',
            display_name: 'X',
            visibility: 'list',
            context_window: 63_999,
            max_context_window: 64_000,
          },
        ],
      }),
    )!;
    expect(small!.contextWindow).toBeUndefined();
    expect(small!.maxContextWindow).toBe(64_000);
  });

  it('counts a changed max_context_window as a different list', async () => {
    const first = codexModelsFromCatalog(CATALOG)!;
    const changed = first.map((m) =>
      m.id === 'gpt-6-luna' ? { ...m, maxContextWindow: 900_000 } : m,
    );
    const results = [first, changed];
    let changes = 0;
    const discovery = new ModelDiscovery({
      probe: () => Promise.resolve(results.shift()!),
      onChange: () => changes++,
      log: () => undefined,
    });
    await discovery.models('codex', 'codex');
    discovery.invalidate();
    await discovery.models('codex', 'codex');
    await new Promise((resolve) => setImmediate(resolve));
    expect(changes).toBe(2);
  });
});

describe('Claude window probe arguments (W1)', () => {
  it('chooses the model at start and asks get_context_usage', () => {
    expect(buildClaudeModelProbeArgs('opus').slice(0, 3)).toEqual(['--model', 'opus', '-p']);
    expect(buildClaudeModelProbeArgs()).not.toContain('--model');
    expect(JSON.parse(claudeContextUsageRequest('r'))).toEqual({
      type: 'control_request',
      request_id: 'r',
      request: { subtype: 'get_context_usage' },
    });
  });
});
