// The context size a user chooses (docs/plans/phase-4-sizes.md S1–S3, S9).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exchangeStarts, trimNotice, trimToTier } from '../../src/features/chat/contextTrim';
import { estimateTokens, type ChatTurn } from '../../src/features/chat/messages';
import { codexModelsFromCatalog } from '../../src/features/chat/modelDiscovery';
import {
  chatModels,
  chosenTier,
  contextTiersFor,
  type ChatModelSettings,
} from '../../src/features/chat/models';

const GATES = {
  trusted: true,
  platform: 'darwin' as NodeJS.Platform,
  claudeAvailable: true,
  codexAvailable: true,
};
const catalog = (): ChatModelSettings['codexModels'] =>
  codexModelsFromCatalog(
    readFileSync(resolve(__dirname, '../fixtures/codex/models.json'), 'utf8'),
  )!;

/** The choices of one model, as `[tiers…, full]`, and whether it is read-only. */
function choices(settings: ChatModelSettings, id: string): { values: number[]; readOnly: boolean } {
  const model = chatModels(settings, GATES).find((m) => m.id === id)!;
  const context = model.configurationSchema!.properties.contextTier!;
  return { values: context.enum, readOnly: context.readOnly === true };
}

describe('the choices (S1)', () => {
  it.each([
    [
      'Claude 1M',
      { claudeModels: [{ id: 'opus', contextWindow: 1_000_000 }], codexModels: [] },
      'claude-cli.opus',
      [128_000, 200_000, 994_000],
    ],
    [
      'Claude 200K',
      { claudeModels: [{ id: 'x', contextWindow: 200_000 }], codexModels: [] },
      'claude-cli.x',
      [128_000, 194_000],
    ],
    [
      'GPT-6-Luna (272K)',
      { claudeModels: [], codexModels: catalog() },
      'codex-cli.gpt-6-luna',
      [128_000, 242_400],
    ],
    [
      'GPT-6.1-Sol (500K)',
      { claudeModels: [], codexModels: catalog() },
      'codex-cli.gpt-6.1-sol',
      [128_000, 200_000, 459_000],
    ],
    [
      'Codex opted in (872K)',
      { claudeModels: [], codexModels: catalog(), codexMaxWindow: true },
      'codex-cli.gpt-6-luna',
      [128_000, 200_000, 812_400],
    ],
    [
      'Claude 1M limited to 300K',
      {
        claudeModels: [{ id: 'opus', contextWindow: 1_000_000 }],
        codexModels: [],
        windowLimit: 300_000,
      },
      'claude-cli.opus',
      [128_000, 200_000, 294_000],
    ],
  ] as [string, ChatModelSettings, string, number[]][])('%s', (_label, settings, id, expected) => {
    expect(choices(settings, id)).toEqual({ values: expected, readOnly: false });
  });

  it("offers only the full size, read-only, for Codex's assumed 128K window", () => {
    expect(choices({ claudeModels: [], codexModels: ['b'] }, 'codex-cli.b')).toEqual({
      values: [105_600],
      readOnly: true,
    });
  });

  it('keeps a tier only up to 80 % of the size', () => {
    expect(contextTiersFor(160_000)).toEqual([128_000]);
    expect(contextTiersFor(159_999)).toEqual([]);
    expect(contextTiersFor(250_000)).toEqual([128_000, 200_000]);
    expect(contextTiersFor(249_999)).toEqual([128_000]);
  });

  it('describes a tier and keeps the full size as the default', () => {
    const [opus] = chatModels(
      { claudeModels: [{ id: 'opus', contextWindow: 1_000_000 }], codexModels: [] },
      GATES,
    );
    const context = opus!.configurationSchema!.properties.contextTier!;
    expect(context.default).toBe(994_000);
    expect(context.enumItemLabels).toEqual(['128K', '200K', '1M']);
    expect(context.enumDescriptions[0]).toBe(
      "Magipilot keeps the conversation within about 128K tokens (it counts each byte as a token, so usually fewer) by leaving the oldest messages out. In Ask mode Copilot Chat itself already sends only about the last five questions, so this matters most with large messages or attachments. Copilot Chat's own instructions and tools are sent in full, and a single message larger than that is sent without older messages. Uses less of your plan's quota.",
    );
    expect(context.enumDescriptions[2]).toContain('of the 1M window that Claude Code reports');
    // The other views keep the full size.
    expect(opus!.maxContextWindowTokens).toBe(994_000);
    expect(opus!.detail).toBe('1M');
  });
});

describe('the size a request uses (S2)', () => {
  const tiers = [128_000, 200_000];

  it('takes a current tier only', () => {
    expect(chosenTier(tiers, 128_000)).toBe(128_000);
    expect(chosenTier(tiers, 200_000)).toBe(200_000);
    for (const value of [994_000, 150_000, undefined, null, '128000', 'default', 'long_context']) {
      expect(chosenTier(tiers, value), String(value)).toBeUndefined();
    }
    expect(chosenTier([], 128_000)).toBeUndefined();
  });
});

const sys = (text: string): ChatTurn => ({ role: 'system', text });
const user = (text: string): ChatTurn => ({ role: 'user', text });
const answer = (text: string): ChatTurn => ({ role: 'assistant', text });
const KB = (n: number, tag: string): string => `${tag} ${'x'.repeat(n * 1000)}`;
/** What a set of turns counts toward a tier: non-system turns, as Copilot counts a message. */
const counted = (turns: readonly ChatTurn[]): number =>
  turns.filter((t) => t.role !== 'system').reduce((sum, t) => sum + estimateTokens(t.text, 1), 0);

function trim(turns: ChatTurn[], tier: number, toolResult: boolean[] = []) {
  const result = trimToTier(turns, exchangeStarts(turns, toolResult), tier);
  return {
    ...result,
    kept: turns.filter((_, i) => result.keep[i]).map((t) => t.text.split(' ')[0]),
  };
}

describe('leaving the oldest exchanges out (S3)', () => {
  it('starts an exchange at a user turn after an answer, or at the first', () => {
    const turns = [sys('s'), user('a'), answer('b'), user('c'), user('d'), answer('e'), user('f')];
    expect(exchangeStarts(turns, [])).toEqual([false, true, false, true, false, false, true]);
    // A tool result never starts one; an orphaned answer is no start either.
    expect(exchangeStarts([answer('o'), user('r')], [false, true])).toEqual([false, false]);
    expect(exchangeStarts([answer('o'), user('q')], [])).toEqual([false, true]);
  });

  it('leaves nothing out when the conversation fits, and never counts system turns', () => {
    const turns = [sys(KB(500, 'S')), user(KB(10, 'U1')), answer('A1'), user(KB(10, 'U2'))];
    expect(trim(turns, 128_000)).toMatchObject({ dropped: 0, overTier: false });
    expect(trim(turns, 128_000).keep.every(Boolean)).toBe(true);
  });

  it('leaves out the oldest exchanges first, the fewest that fit, and keeps the rest together', () => {
    const turns = [
      sys('S'),
      ...[1, 2, 3, 4, 5].flatMap((k) => [user(KB(30, `U${k}`)), answer(`A${k}`)]),
      user(KB(30, 'U6')),
    ];
    const result = trim(turns, 128_000);
    expect(result.kept).toEqual(['S', 'U3', 'A3', 'U4', 'A4', 'U5', 'A5', 'U6']);
    expect(result).toMatchObject({ dropped: 4, overTier: false });
    // It fits, and one exchange fewer left out would not.
    const kept = turns.filter((_, i) => result.keep[i]);
    expect(counted(kept)).toBeLessThanOrEqual(128_000);
    expect(counted(turns.slice(3))).toBeGreaterThan(128_000);
  });

  it('leaves an orphaned leading answer out first', () => {
    const turns = [
      sys('S'),
      answer(KB(5, 'A0')),
      user(KB(62, 'U1')),
      answer('A1'),
      user(KB(62, 'U2')),
    ];
    expect(trim(turns, 128_000).kept).toEqual(['S', 'U1', 'A1', 'U2']);
  });

  it('keeps a tool call with its result, and consecutive user turns together', () => {
    const turns = [
      user(KB(40, 'Q1')),
      answer('CALL'),
      user(KB(40, 'RESULT')),
      answer('A1'),
      user('NOTE'),
      user(KB(60, 'Q2')),
    ];
    const result = trim(turns, 100_000, [false, false, true, false, false, false]);
    expect(result.kept).toEqual(['NOTE', 'Q2']);
    expect(result.dropped).toBe(4);
  });

  it('sends the current exchange alone when it is larger than the tier (D4)', () => {
    const turns = [sys('S'), user(KB(20, 'U1')), answer('A1'), user(KB(150, 'U2'))];
    expect(trim(turns, 128_000)).toMatchObject({ kept: ['S', 'U2'], dropped: 2, overTier: true });
    expect(trim([user(KB(150, 'U'))], 128_000)).toMatchObject({
      kept: ['U'],
      dropped: 0,
      overTier: true,
    });
  });
});

describe('the notice (S9)', () => {
  it('names counts and sizes only', () => {
    expect(trimNotice(4, false, 128_000)).toBe('Magipilot: 4 older messages left out to fit 128K');
    expect(trimNotice(1, false, 200_000)).toBe('Magipilot: 1 older message left out to fit 200K');
    expect(trimNotice(6, true, 128_000)).toBe(
      'Magipilot: sent without the 6 older messages; this message alone is larger than 128K',
    );
    expect(trimNotice(0, true, 128_000)).toBe(
      'Magipilot: this message alone is larger than 128K; sent as it is',
    );
  });
});
