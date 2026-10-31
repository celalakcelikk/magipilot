// phase-5-linux D3 and inspection LINUX-I003: the `--lm` smoke passes only on whole, clean answers.
import { describe, expect, it } from 'vitest';
import { lmFailures } from '../../scripts/lib/smokeVerdict.mjs';

const answer = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  ms: 1000,
  chars: 15,
  tokenFound: true,
  ...extra,
});

const passing = {
  claudeModels: 3,
  codexModels: 1,
  claude: answer('claude-cli.haiku'),
  codex: answer('codex-cli.gpt-6.1-sol'),
};

describe('smoke:lm verdict (phase-5-linux D3)', () => {
  it('passes whole answers with enough models and groups', () => {
    expect(lmFailures(passing, 5)).toEqual([]);
  });

  it('fails a stream that delivered the token and then failed (LINUX-I003)', () => {
    const failures = lmFailures(
      { ...passing, claude: answer('claude-cli.haiku', { error: 'The Claude CLI failed.' }) },
      5,
    );
    expect(failures).toEqual([
      'the claude request (claude-cli.haiku) failed: The Claude CLI failed.',
    ]);
  });

  it('fails an answer without the token', () => {
    const failures = lmFailures(
      { ...passing, codex: answer('codex-cli.gpt-6.1-sol', { tokenFound: false }) },
      5,
    );
    expect(failures).toEqual(['the codex answer (codex-cli.gpt-6.1-sol) lacks the token']);
  });

  it('fails a model that was never asked, too few models, and too few groups', () => {
    const failures = lmFailures({ claudeModels: 1, codexModels: 0, claude: undefined }, 2);
    expect(failures).toEqual([
      'no claude model was asked',
      'no codex model was asked',
      'only 1 Claude models listed',
      'no Codex model listed',
      'only 2 process groups recorded (discovery missing?)',
    ]);
  });

  it('fails without results', () => {
    expect(lmFailures(undefined, 0)).toEqual(['the in-VS Code smoke step produced no results']);
  });
});
