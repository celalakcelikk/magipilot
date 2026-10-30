import { describe, expect, it } from 'vitest';
import { sanitizeJsonLine, sanitizeText } from '../../scripts/lib/cli/sanitize';

const context = {
  homeDir: '/Users/someone',
  extraPaths: ['/private/var/folders/x/T/magipilot-abc'],
};

describe('fixture sanitization', () => {
  it('replaces the home directory and temp paths in plain text', () => {
    expect(sanitizeText('see /Users/someone/.codex/config.toml', context)).toBe(
      'see /Users/USER/.codex/config.toml',
    );
    expect(sanitizeText('cwd /private/var/folders/x/T/magipilot-abc/sub', context)).toBe(
      'cwd /tmp/magipilot-fixture/sub',
    );
  });

  it('redacts installed plugin/skill lists and machine paths in JSON events', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/private/var/folders/x/T/magipilot-abc',
      original_cwd: '/somewhere/else',
      additional_directories: ['/Users/someone/project'],
      messaging_socket_path: '/tmp/cc-socks/1.sock',
      plugins: ['secret-plugin', 'another'],
      skills: ['my-skill'],
      tools: [],
      nested: { message: 'error in /Users/someone/file' },
    });
    const out = JSON.parse(sanitizeJsonLine(line, context)) as Record<string, unknown>;
    expect(out.cwd).toBe('/tmp/magipilot-fixture');
    expect(out.original_cwd).toBe('/tmp/magipilot-fixture');
    expect(out.additional_directories).toEqual(['/tmp/magipilot-fixture-extra']);
    expect(out.messaging_socket_path).toBe('/tmp/redacted.sock');
    expect(out.plugins).toEqual(['<redacted>', '<redacted>']);
    expect(out.skills).toEqual(['<redacted>']);
    expect(out.tools).toEqual([]);
    expect(out.nested).toEqual({ message: 'error in /Users/USER/file' });
  });

  it('sanitizes non-JSON lines as text', () => {
    expect(sanitizeJsonLine('oops /Users/someone/x', context)).toBe('oops /Users/USER/x');
  });
});
