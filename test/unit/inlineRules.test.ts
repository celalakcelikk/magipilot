import { describe, expect, it } from 'vitest';
import {
  CLI_DEBOUNCE_MS,
  debounceFor,
  LOCAL_DEBOUNCE_MS,
  skipReason,
  type InlineSettings,
  type SkipInput,
} from '../../src/features/inline/rules';

const SETTINGS: InlineSettings = {
  enabled: true,
  mode: 'auto',
  debounceMs: null,
  maxPrefixChars: 3000,
  maxSuffixChars: 1000,
  maxLines: 8,
  maxFileSizeKb: 1024,
  importSignatures: true,
  exclude: ['.env*', '*.pem', 'secrets/**'],
  disabledLanguages: ['plaintext', 'markdown'],
};

function input(overrides: Partial<SkipInput> = {}): SkipInput {
  return {
    settings: SETTINGS,
    automatic: true,
    hasSelection: false,
    languageId: 'typescript',
    path: 'src/a.ts',
    sizeBytes: 100,
    ...overrides,
  };
}

describe('skipReason (PLAN §6.2)', () => {
  it('allows a normal request', () => {
    expect(skipReason(input())).toBeUndefined();
  });

  it.each([
    ['disabled', input({ settings: { ...SETTINGS, enabled: false } })],
    ['manual-mode', input({ settings: { ...SETTINGS, mode: 'manual' } })],
    ['selection', input({ hasSelection: true })],
    ['language', input({ languageId: 'markdown' })],
    ['excluded', input({ path: '.env' })],
    ['excluded', input({ path: 'config/.env.local' })],
    ['excluded', input({ path: 'secrets/token.ts' })],
    ['too-large', input({ sizeBytes: 1024 * 1024 + 1 })],
  ])('%s', (reason, value) => {
    expect(skipReason(value)).toBe(reason);
  });

  it('manual mode still serves explicit triggers', () => {
    expect(
      skipReason(input({ settings: { ...SETTINGS, mode: 'manual' }, automatic: false })),
    ).toBeUndefined();
  });
});

describe('debounceFor (D6)', () => {
  it('uses 700 ms for CLI backends and 250 ms for local ones', () => {
    expect(debounceFor(SETTINGS, 'claude-cli', true)).toBe(CLI_DEBOUNCE_MS);
    expect(debounceFor(SETTINGS, 'codex-cli', true)).toBe(CLI_DEBOUNCE_MS);
    expect(debounceFor(SETTINGS, 'ollama', true)).toBe(LOCAL_DEBOUNCE_MS);
  });

  it('honours the setting and never waits for explicit triggers', () => {
    expect(debounceFor({ ...SETTINGS, debounceMs: 50 }, 'claude-cli', true)).toBe(50);
    expect(debounceFor(SETTINGS, 'claude-cli', false)).toBe(0);
  });
});
