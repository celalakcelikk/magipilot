// Builds and caches backends from injected settings (docs/plans/phase-1.md §4.2,
// docs/plans/phase-1-local.md). vscode-free. Gates: CLI backends are refused in untrusted
// workspaces (PLAN §9) and on Windows (D12); the local HTTP backends are allowed everywhere (C2).
import type { Effort } from '../process/cliArgs';
import { WINDOWS_UNSUPPORTED, type ProcessRegistry } from '../process/runner';
import { buildFimPrompt, type CustomFimTemplate, type FimFamily } from '../prompt/fimTemplates';
import { ClaudeCliBackend } from './claudeCli';
import { CodexCliBackend } from './codexCli';
import { OllamaBackend } from './ollama';
import { OpenAiCompatBackend } from './openaiCompat';
import type { Backend, BackendId } from './types';

export type OpenAiCompatMode = 'server' | 'infill' | FimFamily;

export interface BackendSettings {
  inlineBackend: BackendId;
  fallbackBackend: BackendId | 'none';
  claude: {
    path: string;
    inlineModel: string;
    effort: Effort;
    warmPoolSize: number;
    disableNonessentialTraffic: boolean;
  };
  codex: { path: string; inlineModel: string; effort: Effort };
  /** Per-request timeout for CLI backends. */
  cliTimeoutMs: number;
  ollama: { url: string; model: string; fim: 'suffix' | 'raw'; template: FimFamily };
  openaiCompat: { url: string; model: string; fimTemplate: OpenAiCompatMode };
  /** Shared by `ollama.template: custom` and `openaiCompat.fimTemplate: custom`. */
  custom: CustomFimTemplate;
}

export interface RegistryEnvironment {
  platform: NodeJS.Platform;
  isTrusted(): boolean;
  processes: ProcessRegistry;
}

export type Resolution = { id: BackendId; backend: Backend } | { id: BackendId; error: string };

export const UNTRUSTED_REFUSAL = 'CLI backends are disabled in untrusted workspaces';
/** Fixed values for the local backends (C4: no unvalidated numbers from settings, B-I003). */
export const LOCAL_TIMEOUT_MS = 10_000;
export const LOCAL_TEMPERATURE = 0.2;

const CLI_BACKENDS: ReadonlySet<BackendId> = new Set(['claude-cli', 'codex-cli']);
const SETTINGS_PREFIX: Record<BackendId, string> = {
  'claude-cli': 'magipilot.claude.*',
  'codex-cli': 'magipilot.codex.*',
  ollama: 'magipilot.ollama.*',
  'openai-compat': 'magipilot.openaiCompat.*',
};

/** Fixed refusal text for a backend that cannot be built from its settings (C5). */
export function invalidConfiguration(id: BackendId): string {
  return `${id}: invalid configuration — check the ${SETTINGS_PREFIX[id]} settings`;
}

export class BackendRegistry {
  private settings?: BackendSettings;
  private settingsKey = '';
  private readonly backends = new Map<BackendId, Backend>();
  private override?: Backend;
  private generationCounter = 0;

  constructor(private readonly env: RegistryEnvironment) {}

  /** Changes whenever the backend, model or any backend setting changes (cache invalidation). */
  get generation(): number {
    return this.generationCounter;
  }

  configure(settings: BackendSettings): void {
    const key = JSON.stringify(settings);
    if (key === this.settingsKey) return;
    this.disposeBackends();
    this.settings = settings;
    this.settingsKey = key;
    this.generationCounter++;
  }

  /** Test hook (integration tests only): replaces the inline backend. */
  setOverride(backend: Backend | undefined): void {
    this.override = backend;
    this.generationCounter++;
  }

  resolve(id: BackendId): Resolution {
    if (CLI_BACKENDS.has(id)) {
      if (this.env.platform === 'win32') return { id, error: WINDOWS_UNSUPPORTED };
      if (!this.env.isTrusted()) return { id, error: UNTRUSTED_REFUSAL };
    }
    const existing = this.backends.get(id);
    if (existing) return { id, backend: existing };
    let backend: Backend;
    try {
      backend = this.create(id);
    } catch {
      // Constructor validation (URL, modes) or the custom-template check failed. The message is
      // fixed so no setting value reaches the log or a notification.
      return { id, error: invalidConfiguration(id) };
    }
    this.backends.set(id, backend);
    return { id, backend };
  }

  /** Primary then fallback (when configured and different). */
  inlineCandidates(): Resolution[] {
    if (this.override) return [{ id: this.override.id, backend: this.override }];
    if (!this.settings) return [];
    const ids: BackendId[] = [this.settings.inlineBackend];
    const fallback = this.settings.fallbackBackend;
    if (fallback !== 'none' && fallback !== this.settings.inlineBackend) ids.push(fallback);
    return ids.map((id) => this.resolve(id));
  }

  /** Throws when the custom template cannot build a prompt (C5, mitigates B-I004). */
  private checkedCustom(family: string): CustomFimTemplate | undefined {
    if (family !== 'custom') return undefined;
    const custom = this.settings!.custom;
    buildFimPrompt(
      'custom',
      { prefix: 'a', suffix: 'b', snippets: [], filePath: 'x' },
      { template: custom.template, stop: [...custom.stop] },
    );
    return custom;
  }

  private create(id: BackendId): Backend {
    const settings = this.settings!;
    switch (id) {
      case 'claude-cli': {
        const backend = new ClaudeCliBackend({
          path: settings.claude.path,
          model: settings.claude.inlineModel,
          effort: settings.claude.effort,
          warmPoolSize: settings.claude.warmPoolSize,
          disableNonessentialTraffic: settings.claude.disableNonessentialTraffic,
          timeoutMs: settings.cliTimeoutMs,
          processes: this.env.processes,
        });
        backend.prime();
        return backend;
      }
      case 'codex-cli':
        return new CodexCliBackend({
          path: settings.codex.path,
          model: settings.codex.inlineModel,
          effort: settings.codex.effort,
          timeoutMs: settings.cliTimeoutMs,
          processes: this.env.processes,
        });
      case 'ollama':
        return new OllamaBackend({
          baseUrl: settings.ollama.url,
          model: settings.ollama.model,
          fim: settings.ollama.fim,
          template: settings.ollama.template,
          custom: this.checkedCustom(settings.ollama.template),
          timeoutMs: LOCAL_TIMEOUT_MS,
          temperature: LOCAL_TEMPERATURE,
        });
      case 'openai-compat':
        return new OpenAiCompatBackend({
          baseUrl: settings.openaiCompat.url,
          model: settings.openaiCompat.model,
          fimTemplate: settings.openaiCompat.fimTemplate,
          custom: this.checkedCustom(settings.openaiCompat.fimTemplate),
          timeoutMs: LOCAL_TIMEOUT_MS,
          temperature: LOCAL_TEMPERATURE,
        });
    }
  }

  private disposeBackends(): void {
    for (const backend of this.backends.values()) backend.dispose();
    this.backends.clear();
  }

  dispose(): void {
    this.disposeBackends();
    this.override = undefined;
  }
}
