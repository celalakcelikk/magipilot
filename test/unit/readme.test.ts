// docs/plans/phase-3-package.md AC4, K7: README.md documents every user-facing command and every
// setting that package.json contributes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    menus?: { commandPalette?: { command: string; when?: string }[] };
    configuration: { properties: Record<string, unknown> };
  };
};

// Commands hidden from the Command Palette (`when: false`) are not for users: the Faz 0 probe.
const hidden = new Set(
  (pkg.contributes.menus?.commandPalette ?? [])
    .filter((entry) => entry.when === 'false')
    .map((entry) => entry.command),
);

describe('README.md', () => {
  it('names every user-facing command as it appears in the Command Palette', () => {
    const commands = pkg.contributes.commands.filter((c) => !hidden.has(c.command));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(readme, command.command).toContain(
        `${command.category ?? 'Magipilot'}: ${command.title}`,
      );
    }
  });

  it('documents every setting', () => {
    const settings = Object.keys(pkg.contributes.configuration.properties);
    expect(settings.length).toBeGreaterThan(0);
    for (const setting of settings) expect(readme, setting).toContain(`\`${setting}\``);
  });

  it('keeps the disclaimer and the installation steps', () => {
    expect(readme).toContain(
      'Not affiliated with or endorsed by GitHub, Microsoft, Anthropic, or OpenAI.',
    );
    expect(readme).toContain('code --install-extension');
  });
});
