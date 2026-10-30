// The model picker's settings and sizes (docs/plans/phase-4-picker.md U1–U3, U6, U7).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claudeModelsFromLine,
  codexModelsFromCatalog,
  versionedName,
} from '../../src/features/chat/modelDiscovery';
import {
  chatModels,
  contextTiersFor,
  effortFor,
  maxInputTokens,
  windowLabel,
  type ChatModelSettings,
} from '../../src/features/chat/models';

const GATES = {
  trusted: true,
  platform: 'darwin' as NodeJS.Platform,
  claudeAvailable: true,
  codexAvailable: true,
};
const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, '../fixtures', name), 'utf8');

/** Claude's `initialize` answer around a recorded model list. */
function initializeLine(models: unknown): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: 'r', response: { models } },
  });
}

describe('advertised size and context setting (U1, U6)', () => {
  const cases: [string, ChatModelSettings][] = [
    ['Claude 1M', { claudeModels: [{ id: 'opus', contextWindow: 1_000_000 }], codexModels: [] }],
    ['Claude 200K', { claudeModels: [{ id: 'x', contextWindow: 200_000 }], codexModels: [] }],
    ['Claude 64K', { claudeModels: [{ id: 'x', contextWindow: 64_000 }], codexModels: [] }],
    [
      'Claude capped',
      {
        claudeModels: [{ id: 'opus', contextWindow: 1_000_000 }],
        codexModels: [],
        windowLimit: 300_000,
      },
    ],
    [
      'Codex catalog',
      { claudeModels: [], codexModels: codexModelsFromCatalog(fixture('codex/models.json'))! },
    ],
    [
      'Codex opted in',
      {
        claudeModels: [],
        codexModels: codexModelsFromCatalog(fixture('codex/models.json'))!,
        codexMaxWindow: true,
      },
    ],
    ['configured ids', { claudeModels: ['a'], codexModels: ['b'] }],
  ];

  it.each(cases)('%s: one size everywhere, Manage Models sum included', (_label, settings) => {
    const models = chatModels(settings, GATES);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const size = model.maxInputTokens + model.maxOutputTokens;
      expect(model.maxContextWindowTokens, model.id).toBe(size);
      expect(model.detail).toBe(windowLabel(size));
      // The output limit stays the real answer reserve (plan review P4PICK-R002).
      expect(model.maxOutputTokens).toBe(model.backend === 'claude-cli' ? 32_000 : 16_000);
      // Under `contextTier` (phase-4-sizes.md S1, D7): the tiers, then the full size.
      expect(model.configurationSchema!.properties).not.toHaveProperty('contextSize');
      const context = model.configurationSchema!.properties.contextTier!;
      const tiers = contextTiersFor(size);
      expect(context).toMatchObject({
        type: 'number',
        title: 'Context Size',
        enum: [...tiers, size],
        enumItemLabels: [...tiers, size].map(windowLabel),
        default: size,
        group: 'tokens',
      });
      expect(model.contextTiers).toEqual(tiers);
      // Read-only only when the full size is the only choice.
      expect(context.readOnly).toBe(tiers.length === 0 ? true : undefined);
      // The default is never below the input budget (U3).
      expect(context.default).toBeGreaterThanOrEqual(model.maxInputTokens);
    }
  });

  it("names the CLI's own window in the description and the tooltip", () => {
    const [opus] = chatModels(
      {
        claudeModels: [{ id: 'opus', displayName: 'Opus 5.5', contextWindow: 1_000_000 }],
        codexModels: [],
      },
      GATES,
    );
    const text = opus!.configurationSchema!.properties.contextTier!.enumDescriptions.at(-1)!;
    expect(text).toBe(
      "Magipilot can use about 994K tokens, the answer included, of the 1M window that Claude Code reports; the rest is kept for Claude Code's own instructions.",
    );
    expect(opus!.tooltip).toContain(text);
    const luna = chatModels(
      { claudeModels: [], codexModels: codexModelsFromCatalog(fixture('codex/models.json'))! },
      GATES,
    ).find((m) => m.id === 'codex-cli.gpt-6-luna')!;
    expect(luna.configurationSchema!.properties.contextTier!.enumDescriptions.at(-1)).toContain(
      'about 242K tokens, the answer included, of the 272K window that Codex reports;',
    );
    expect(maxInputTokens('codex-cli', 272_000) + 16_000).toBe(242_400);
  });

  it("names the CLI's full window and the user's limit apart (P4PICK-I002)", () => {
    const [opus] = chatModels(
      {
        claudeModels: [{ id: 'opus', contextWindow: 1_000_000 }],
        codexModels: [],
        windowLimit: 300_000,
      },
      GATES,
    );
    expect(opus!.maxContextWindowTokens).toBe(294_000);
    const text = opus!.configurationSchema!.properties.contextTier!.enumDescriptions.at(-1)!;
    expect(text).toBe(
      "Magipilot can use about 294K tokens, the answer included, of the 1M window that Claude Code reports, limited to 300K by magipilot.chat.contextWindowLimit; the rest is kept for Claude Code's own instructions.",
    );
    expect(opus!.tooltip).toContain(text);
    // A limit above the window changes nothing, and is not named.
    const [wide] = chatModels(
      {
        claudeModels: [{ id: 'x', contextWindow: 200_000 }],
        codexModels: [],
        windowLimit: 500_000,
      },
      GATES,
    );
    expect(
      wide!.configurationSchema!.properties.contextTier!.enumDescriptions.at(-1),
    ).not.toContain('limited');
    // With Codex's opt-in, the full window is the largest catalog window.
    const luna = chatModels(
      {
        claudeModels: [],
        codexModels: codexModelsFromCatalog(fixture('codex/models.json'))!,
        codexMaxWindow: true,
      },
      GATES,
    ).find((m) => m.id === 'codex-cli.gpt-6-luna')!;
    expect(luna.configurationSchema!.properties.contextTier!.enumDescriptions.at(-1)).toContain(
      'of the 872K window that Codex reports;',
    );
  });

  it("formats sizes as VS Code's own Manage Models column does", () => {
    for (const [tokens, text] of [
      [994_000, '1M'],
      [900_001, '1M'],
      [900_000, '900K'],
      [242_400, '242K'],
      [194_000, '194K'],
      [1_000_000, '1M'],
      [1_500_000, '1.5M'],
      [2_000_000, '2M'],
      [999, '999'],
    ] as const) {
      expect(windowLabel(tokens), String(tokens)).toBe(text);
    }
  });
});

describe('effort in the label and the card (U2, U3)', () => {
  it("groups the effort as VS Code's own models do, with its name", () => {
    const [opus] = chatModels(
      {
        claudeModels: [{ id: 'opus', efforts: [{ id: 'low' }, { id: 'xhigh' }] }],
        codexModels: [],
      },
      GATES,
    );
    const effort = opus!.configurationSchema!.properties.reasoningEffort!;
    expect(effort).toMatchObject({
      title: 'Effort Level',
      group: 'navigation',
      enum: ['auto', 'low', 'xhigh'],
      enumItemLabels: ['Auto', 'Low', 'Extra High'],
      default: 'auto',
    });
  });

  it('takes the effort as before; the context size changes nothing', () => {
    const [luna] = chatModels(
      {
        claudeModels: [],
        codexModels: codexModelsFromCatalog(fixture('codex/models.json'))!.filter(
          (m) => m.id === 'gpt-6-luna',
        ),
      },
      GATES,
    );
    const schema = luna!.configurationSchema;
    expect(effortFor(schema, 'high')).toBe('high');
    expect(effortFor(schema, undefined)).toBe('medium');
    // VS Code fills the configuration with every default, the context size included.
    expect(effortFor(schema, 'xhigh')).toBe('xhigh');
    const withContext = { reasoningEffort: 'low', contextSize: 242_400 };
    expect(effortFor(schema, withContext.reasoningEffort)).toBe('low');
  });
});

describe('versioned Claude names (U7)', () => {
  it('takes the version from the description in privacy mode', () => {
    const recorded = JSON.parse(fixture('claude/models-privacy.json')) as unknown[];
    const models = claudeModelsFromLine(initializeLine(recorded))!;
    expect(models.map((m) => [m.id, m.displayName])).toEqual([
      ['opus', 'Opus 5.5'],
      ['sonnet', 'Sonnet 5.5'],
      ['haiku', 'Haiku 5.5'],
    ]);
  });

  it('keeps the names of the full answer', () => {
    const recorded = JSON.parse(fixture('claude/models.json')) as unknown[];
    const models = claudeModelsFromLine(initializeLine(recorded))!;
    const byId = new Map(models.map((m) => [m.id, m.displayName]));
    expect(byId.get('opus')).toBe('Opus 5.5');
    expect(byId.get('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('changes a name only when the prefix extends it', () => {
    expect(versionedName('Opus', 'Opus 5.5 · Best for everyday, complex tasks')).toBe('Opus 5.5');
    expect(versionedName('Opus', 'Sonnet 5.5 · Efficient')).toBe('Opus');
    expect(versionedName('Opus', 'Opus5.5 · x')).toBe('Opus');
    expect(versionedName('Opus 5.5', 'For complex work and everyday tasks')).toBe('Opus 5.5');
    expect(versionedName('Opus', ' · x')).toBe('Opus');
    expect(versionedName('Opus', `Opus ${'9'.repeat(200)} · x`)).toBe('Opus');
    expect(versionedName('Opus', 42)).toBe('Opus');
  });
});
