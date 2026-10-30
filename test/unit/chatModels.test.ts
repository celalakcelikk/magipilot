import { describe, expect, it } from 'vitest';
import {
  chatModels,
  cliOverhead,
  supportsToolCalling,
  CONVERSION_RESERVE,
  maxInputTokens,
  overridingScope,
  parseChatModelId,
  type ChatGates,
} from '../../src/features/chat/models';

const OPEN: ChatGates = {
  trusted: true,
  platform: 'darwin',
  claudeAvailable: true,
  codexAvailable: true,
};
const SETTINGS = { claudeModels: ['sonnet', 'haiku'], codexModels: ['gpt-6.1-sol'] };

describe('chatModels (D1, D5, D6, D7)', () => {
  it('empty settings → no models (PLAN §8 default)', () => {
    expect(chatModels({ claudeModels: [], codexModels: [] }, OPEN)).toEqual([]);
  });

  it('lists the Claude and Codex models with ids, names and limits', () => {
    const models = chatModels(SETTINGS, OPEN);
    expect(models.map((m) => m.id)).toEqual([
      'claude-cli.sonnet',
      'claude-cli.haiku',
      'codex-cli.gpt-6.1-sol',
    ]);
    expect(models[0]).toMatchObject({
      // A configured id without discovery: the id is the name; the detail is the size Magipilot
      // can use, input and output (phase-4-picker.md U6).
      name: 'sonnet',
      detail: '194K',
      maxContextWindowTokens: 194_000,
      family: 'claude-cli',
      model: 'sonnet',
      maxInputTokens: 200_000 - 32_000 - cliOverhead('claude-cli') - CONVERSION_RESERVE,
      maxOutputTokens: 32_000,
    });
    expect(models[2]).toMatchObject({
      name: 'gpt-6.1-sol',
      detail: '106K',
      // 95 % of Codex's window is usable (phase-4-context.md W3).
      maxInputTokens:
        Math.floor(128_000 * 0.95) - 16_000 - cliOverhead('codex-cli') - CONVERSION_RESERVE,
      maxOutputTokens: 16_000,
    });
    // The CLI's own instructions are reserved too (phase-4-tokens.md, P4TOK-R001).
    expect(cliOverhead('claude-cli')).toBe(2_000);
    expect(cliOverhead('codex-cli')).toBe(12_000);
    expect(maxInputTokens('claude-cli')).toBe(162_000);
    expect(maxInputTokens('codex-cli')).toBe(89_600);
  });

  it.each([
    ['untrusted', { ...OPEN, trusted: false }],
    ['Windows', { ...OPEN, platform: 'win32' as const }],
  ])('%s → no models', (_label, gates) => {
    expect(chatModels(SETTINGS, gates)).toEqual([]);
  });

  it('a missing CLI hides only its own models', () => {
    expect(chatModels(SETTINGS, { ...OPEN, claudeAvailable: false }).map((m) => m.id)).toEqual([
      'codex-cli.gpt-6.1-sol',
    ]);
  });

  it('skips unusable and duplicate ids', () => {
    const models = chatModels(
      { claudeModels: ['sonnet', ' sonnet ', 'a/b', '--tools', '', 'x y'], codexModels: [] },
      OPEN,
    );
    expect(models.map((m) => m.model)).toEqual(['sonnet']);
  });
});

describe('parseChatModelId', () => {
  it('parses Magipilot ids and rejects anything else', () => {
    expect(parseChatModelId('claude-cli.sonnet')).toEqual({
      backend: 'claude-cli',
      model: 'sonnet',
    });
    expect(parseChatModelId('codex-cli.gpt-6.1-sol')).toEqual({
      backend: 'codex-cli',
      model: 'gpt-6.1-sol',
    });
    expect(parseChatModelId('magipilot-echo')).toBeUndefined();
    expect(parseChatModelId('claude-cli.--tools')).toBeUndefined();
  });
});

describe('overridingScope (P2-R003, P2-I002)', () => {
  const value = 'magipilot/claude-cli.haiku';

  it('reports a workspace or folder value that differs', () => {
    expect(overridingScope({ workspaceValue: 'copilot/x' }, value)).toBe('Workspace');
    expect(overridingScope({ workspaceFolderValue: 'copilot/x' }, value)).toBe('Workspace Folder');
  });

  it('accepts matching or missing values', () => {
    expect(overridingScope(undefined, value)).toBeUndefined();
    expect(overridingScope({}, value)).toBeUndefined();
    expect(overridingScope({ workspaceValue: value }, value)).toBeUndefined();
  });

  it('a matching folder value shadows a different workspace value', () => {
    expect(
      overridingScope({ workspaceValue: 'copilot/x', workspaceFolderValue: value }, value),
    ).toBeUndefined();
  });
});

describe('tool calling per CLI (docs/bench.md, P4T-REV-002)', () => {
  it('is declared for Claude and not for Codex', () => {
    expect(supportsToolCalling('claude-cli')).toBe(true);
    expect(supportsToolCalling('codex-cli')).toBe(false);
  });
});
