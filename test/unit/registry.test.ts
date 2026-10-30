import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OllamaBackend } from '../../src/core/backends/ollama';
import { OpenAiCompatBackend } from '../../src/core/backends/openaiCompat';
import {
  BackendRegistry,
  invalidConfiguration,
  UNTRUSTED_REFUSAL,
  type BackendSettings,
} from '../../src/core/backends/registry';
import type { Backend } from '../../src/core/backends/types';
import { ProcessRegistry, WINDOWS_UNSUPPORTED } from '../../src/core/process/runner';

const SETTINGS: BackendSettings = {
  inlineBackend: 'claude-cli',
  fallbackBackend: 'none',
  // warmPoolSize 0: building a backend spawns nothing.
  claude: {
    path: 'claude',
    inlineModel: 'haiku',
    effort: 'low',
    warmPoolSize: 0,
    disableNonessentialTraffic: true,
  },
  codex: { path: 'codex', inlineModel: 'gpt-6-luna', effort: 'low' },
  cliTimeoutMs: 30_000,
  ollama: {
    url: 'http://localhost:11434',
    model: 'qwen2.5-coder:1.5b',
    fim: 'suffix',
    template: 'qwen',
  },
  openaiCompat: { url: 'http://localhost:8080', model: '', fimTemplate: 'server' },
  custom: { template: '', stop: [] },
};

const processes = new ProcessRegistry({ watchdog: false });
const registries: BackendRegistry[] = [];

function make(options: { platform?: NodeJS.Platform; trusted?: boolean } = {}): BackendRegistry {
  const registry = new BackendRegistry({
    platform: options.platform ?? 'darwin',
    isTrusted: () => options.trusted ?? true,
    processes,
  });
  registries.push(registry);
  return registry;
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

function errorOf(result: ReturnType<BackendRegistry['resolve']>): string | undefined {
  return 'error' in result ? result.error : undefined;
}

function backendOf(result: ReturnType<BackendRegistry['resolve']>): Backend | undefined {
  return 'backend' in result ? result.backend : undefined;
}

describe('BackendRegistry', () => {
  it('builds the configured CLI backend and caches it', () => {
    const registry = make();
    registry.configure(SETTINGS);
    const [first] = registry.inlineCandidates();
    const [second] = registry.inlineCandidates();
    expect(first && backendOf(first)?.id).toBe('claude-cli');
    expect(second && backendOf(second)).toBe(first && backendOf(first));
  });

  it('refuses CLI backends in untrusted workspaces (PLAN §9)', () => {
    const registry = make({ trusted: false });
    registry.configure(SETTINGS);
    expect(errorOf(registry.resolve('claude-cli'))).toBe(UNTRUSTED_REFUSAL);
    expect(errorOf(registry.resolve('codex-cli'))).toBe(UNTRUSTED_REFUSAL);
  });

  it('refuses CLI backends on Windows (D12)', () => {
    const registry = make({ platform: 'win32' });
    registry.configure(SETTINGS);
    expect(errorOf(registry.resolve('claude-cli'))).toBe(WINDOWS_UNSUPPORTED);
    expect(errorOf(registry.resolve('codex-cli'))).toBe(WINDOWS_UNSUPPORTED);
  });

  for (const [label, options] of [
    ['trusted on macOS', {}],
    ['in an untrusted workspace (C2)', { trusted: false }],
    ['on Windows (C2)', { platform: 'win32' as const }],
  ] as const) {
    it(`builds the local backends ${label}`, () => {
      const registry = make(options);
      registry.configure(SETTINGS);
      expect(backendOf(registry.resolve('ollama'))).toBeInstanceOf(OllamaBackend);
      expect(backendOf(registry.resolve('openai-compat'))).toBeInstanceOf(OpenAiCompatBackend);
    });
  }

  it('turns an invalid local URL into a fixed refusal, without the setting value (C5)', () => {
    const registry = make();
    registry.configure({
      ...SETTINGS,
      ollama: { ...SETTINGS.ollama, url: 'ftp://secret-host.example/' },
      openaiCompat: { ...SETTINGS.openaiCompat, url: 'http://user:pw@localhost:8080' },
    });
    const ollama = errorOf(registry.resolve('ollama'));
    expect(ollama).toBe(invalidConfiguration('ollama'));
    expect(ollama).not.toContain('secret-host');
    expect(errorOf(registry.resolve('openai-compat'))).toBe(invalidConfiguration('openai-compat'));
  });

  it('refuses an unusable custom template before building the backend (C5, B-I004)', () => {
    const registry = make();
    registry.configure({
      ...SETTINGS,
      openaiCompat: { ...SETTINGS.openaiCompat, fimTemplate: 'custom' },
      ollama: { ...SETTINGS.ollama, fim: 'raw', template: 'custom' },
      custom: { template: 'only {prefix}', stop: [] },
    });
    expect(errorOf(registry.resolve('openai-compat'))).toBe(invalidConfiguration('openai-compat'));
    expect(errorOf(registry.resolve('ollama'))).toBe(invalidConfiguration('ollama'));
  });

  it('accepts a valid custom template', () => {
    const registry = make();
    registry.configure({
      ...SETTINGS,
      openaiCompat: { ...SETTINGS.openaiCompat, fimTemplate: 'custom' },
      custom: { template: '<PRE>{prefix}<SUF>{suffix}<MID>', stop: ['<EOT>'] },
    });
    expect(backendOf(registry.resolve('openai-compat'))).toBeInstanceOf(OpenAiCompatBackend);
  });

  it('lists the fallback after the primary, never twice — CLI → local and local → CLI', () => {
    const registry = make();
    registry.configure({ ...SETTINGS, fallbackBackend: 'ollama' });
    expect(registry.inlineCandidates().map((c) => c.id)).toEqual(['claude-cli', 'ollama']);
    registry.configure({ ...SETTINGS, inlineBackend: 'ollama', fallbackBackend: 'codex-cli' });
    expect(registry.inlineCandidates().map((c) => c.id)).toEqual(['ollama', 'codex-cli']);
    registry.configure({ ...SETTINGS, inlineBackend: 'ollama', fallbackBackend: 'ollama' });
    expect(registry.inlineCandidates().map((c) => c.id)).toEqual(['ollama']);
  });

  it('changes the generation only when settings change, and rebuilds backends', () => {
    const registry = make();
    registry.configure(SETTINGS);
    const generation = registry.generation;
    const before = registry.resolve('claude-cli');
    registry.configure({ ...SETTINGS });
    expect(registry.generation).toBe(generation);
    registry.configure({ ...SETTINGS, claude: { ...SETTINGS.claude, inlineModel: 'sonnet' } });
    expect(registry.generation).toBe(generation + 1);
    expect(backendOf(registry.resolve('claude-cli'))).not.toBe(backendOf(before));
  });

  it('local settings take part in the generation (cache invalidation)', () => {
    const registry = make();
    registry.configure(SETTINGS);
    const generation = registry.generation;
    const before = backendOf(registry.resolve('ollama'));
    registry.configure({ ...SETTINGS, ollama: { ...SETTINGS.ollama, model: 'qwen2.5-coder:7b' } });
    expect(registry.generation).toBe(generation + 1);
    expect(backendOf(registry.resolve('ollama'))).not.toBe(before);
    registry.configure({
      ...SETTINGS,
      ollama: { ...SETTINGS.ollama, model: 'qwen2.5-coder:7b' },
      custom: { template: '{prefix}{suffix}', stop: [] },
    });
    expect(registry.generation).toBe(generation + 2);
  });

  it('a test override replaces the inline backend and bumps the generation', () => {
    const registry = make({ trusted: false });
    registry.configure(SETTINGS);
    const generation = registry.generation;
    const fake = { id: 'ollama', kind: 'fim' } as unknown as Backend;
    registry.setOverride(fake);
    expect(registry.inlineCandidates()).toEqual([{ id: 'ollama', backend: fake }]);
    expect(registry.generation).toBe(generation + 1);
  });
});

describe('package.json settings (C1, C3)', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
    contributes: {
      configuration: { properties: Record<string, { default?: unknown; scope?: string }> };
    };
    capabilities: { untrustedWorkspaces: { restrictedConfigurations: string[] } };
  };
  const props = pkg.contributes.configuration.properties;

  it('the server URLs are machine-scoped and restricted in untrusted workspaces', () => {
    for (const key of ['magipilot.ollama.url', 'magipilot.openaiCompat.url']) {
      expect(props[key]?.scope).toBe('machine');
      expect(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations).toContain(key);
    }
  });

  it('declares the local settings with the C3 defaults', () => {
    expect(props['magipilot.ollama.url']?.default).toBe('http://localhost:11434');
    expect(props['magipilot.ollama.model']?.default).toBe('qwen2.5-coder:1.5b');
    expect(props['magipilot.ollama.fim']?.default).toBe('suffix');
    expect(props['magipilot.ollama.template']?.default).toBe('qwen');
    expect(props['magipilot.openaiCompat.url']?.default).toBe('http://localhost:8080');
    expect(props['magipilot.openaiCompat.model']?.default).toBe('');
    expect(props['magipilot.openaiCompat.fimTemplate']?.default).toBe('server');
    expect(props['magipilot.openaiCompat.customTemplate']?.default).toBe('');
    expect(props['magipilot.openaiCompat.customStop']?.default).toEqual([]);
  });
});
