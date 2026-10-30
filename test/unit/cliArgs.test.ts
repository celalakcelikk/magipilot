import { realpathSync, readdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeArgs,
  buildCodexArgs,
  claudeStreamJsonUserMessage,
} from '../../src/core/process/cliArgs';
import { makeEmptyDir } from '../../src/core/process/runner';

function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildClaudeArgs', () => {
  const args = buildClaudeArgs({ model: 'haiku', systemPrompt: 'sys' });

  it('runs print mode with no tools and stream-json output', () => {
    expect(args[0]).toBe('-p');
    expect(valueAfter(args, '--tools')).toBe('');
    expect(valueAfter(args, '--model')).toBe('haiku');
    expect(valueAfter(args, '--system-prompt')).toBe('sys');
    expect(valueAfter(args, '--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose'); // stream-json requires it (cli-notes E1)
    expect(args).toContain('--include-partial-messages');
  });

  it('isolates from user configuration and does not persist sessions by default', () => {
    expect(args).toContain('--safe-mode');
    expect(args).toContain('--strict-mcp-config');
    expect(valueAfter(args, '--setting-sources')).toBe('');
    expect(args).toContain('--no-session-persistence');
  });

  it('the cli-verify control drops only --safe-mode; tools, MCP and user settings stay off (review P0-I001)', () => {
    const control = buildClaudeArgs({
      model: 'haiku',
      systemPrompt: 's',
      isolation: 'without-safe-mode',
    });
    expect(control).not.toContain('--safe-mode');
    expect(valueAfter(control, '--tools')).toBe('');
    expect(control).toContain('--strict-mcp-config');
    expect(valueAfter(control, '--setting-sources')).toBe('');
    expect(control).not.toContain('--mcp-config');
    const projectControl = buildClaudeArgs({
      model: 'haiku',
      systemPrompt: 's',
      isolation: 'without-safe-mode',
      settingSources: 'project',
    });
    expect(valueAfter(projectControl, '--setting-sources')).toBe('project');
    expect(projectControl).toContain('--strict-mcp-config');
  });

  it('supports stream-json input and effort', () => {
    const session = buildClaudeArgs({
      model: 'haiku',
      systemPrompt: 's',
      inputFormat: 'stream-json',
      effort: 'low',
    });
    expect(valueAfter(session, '--input-format')).toBe('stream-json');
    expect(valueAfter(session, '--effort')).toBe('low');
  });

  it('encodes one stream-json user turn per line', () => {
    const line = claudeStreamJsonUserMessage('hi "there"');
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi "there"' },
    });
  });
});

describe('buildCodexArgs', () => {
  const args = buildCodexArgs({
    model: 'gpt-6-luna',
    effort: 'low',
    cwd: '/tmp/empty',
    lastMessagePath: '/tmp/out/last.txt',
  });

  it('runs exec read-only, ephemeral, with JSON events and the prompt on stdin', () => {
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toContain('--ephemeral');
    expect(valueAfter(args, '-s')).toBe('read-only');
    expect(valueAfter(args, '-m')).toBe('gpt-6-luna');
    expect(valueAfter(args, '-C')).toBe('/tmp/empty');
    expect(valueAfter(args, '-o')).toBe('/tmp/out/last.txt');
    expect(args.at(-1)).toBe('-');
    expect(args).toContain('--skip-git-repo-check');
  });

  it('ignores user config and rules and uses the lean profile by default', () => {
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('--ignore-rules');
    expect(args).toContain('skills.include_instructions=false');
    const disabled = args.flatMap((a, i) => (a === '--disable' ? [args[i + 1]] : []));
    expect(disabled).toEqual(
      expect.arrayContaining(['plugins', 'apps', 'shell_tool', 'multi_agent']),
    );
  });

  it('keeps the user config only when asked', () => {
    const withConfig = buildCodexArgs({
      model: 'm',
      effort: 'low',
      cwd: '/tmp/e',
      lastMessagePath: '/tmp/o',
      ignoreUserConfig: false,
      profile: 'default',
    });
    expect(withConfig).not.toContain('--ignore-user-config');
    expect(withConfig).not.toContain('skills.include_instructions=false');
  });
});

describe('makeEmptyDir', () => {
  it('creates a fresh empty directory under the system temp dir, never the workspace', () => {
    const dir = makeEmptyDir('magipilot-test-');
    try {
      expect(readdirSync(dir)).toEqual([]);
      expect(realpathSync(dir).startsWith(realpathSync(tmpdir()))).toBe(true);
      expect(realpathSync(dir)).not.toBe(realpathSync(process.cwd()));
    } finally {
      rmdirSync(dir);
    }
  });
});
