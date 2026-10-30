// vscode-free decisions of the inline provider (PLAN §6.1–6.2), unit-tested in vitest.
import { failureMessage, type CliFailureKind } from '../../core/backends/failures';
import type { BackendId } from '../../core/backends/types';
import { isExcluded, platformExcludeOptions } from '../../core/context/exclude';

export interface InlineSettings {
  enabled: boolean;
  mode: 'auto' | 'manual';
  /** null = per backend (D6). */
  debounceMs: number | null;
  maxPrefixChars: number;
  maxSuffixChars: number;
  maxLines: number;
  maxFileSizeKb: number;
  /** Signatures of locally imported files in the prompt (docs/plans/phase-3-context.md). */
  importSignatures: boolean;
  exclude: string[];
  disabledLanguages: string[];
}

/** Output limit of one inline completion (`maxTokens`); shared with the bench's production rows. */
export const INLINE_MAX_TOKENS = 256;

// Tuned by typing replay over the recorded latencies (docs/bench.md, Faz 3 — debounce and cache
// tuning): local 200 → 250 ms; CLI unchanged.
export const CLI_DEBOUNCE_MS = 700;
export const LOCAL_DEBOUNCE_MS = 250;

const CLI_BACKENDS: ReadonlySet<BackendId> = new Set(['claude-cli', 'codex-cli']);

export interface SkipInput {
  settings: InlineSettings;
  automatic: boolean;
  hasSelection: boolean;
  languageId: string;
  /** Workspace-relative path when inside a folder, otherwise the absolute path. */
  path: string;
  sizeBytes: number;
}

export type SkipReason =
  'disabled' | 'manual-mode' | 'selection' | 'language' | 'excluded' | 'too-large';

/** Why no request may be sent for this position, or undefined when one may. */
export function skipReason(input: SkipInput): SkipReason | undefined {
  const { settings } = input;
  if (!settings.enabled) return 'disabled';
  if (settings.mode === 'manual' && input.automatic) return 'manual-mode';
  if (input.hasSelection) return 'selection';
  if (settings.disabledLanguages.includes(input.languageId)) return 'language';
  if (isExcluded(input.path, settings.exclude, platformExcludeOptions())) return 'excluded';
  if (input.sizeBytes > settings.maxFileSizeKb * 1024) return 'too-large';
  return undefined;
}

/** What to tell the user when a backend is not available (phase-3-errors §4). */
export function unavailableMessage(backend: BackendId): string {
  if (backend === 'claude-cli') return failureMessage('claude', 'not-installed');
  if (backend === 'codex-cli') return failureMessage('codex', 'not-installed');
  return 'not available (is it installed, and is its path setting correct?)';
}

/** How long a backend gets no automatic request after a failure of this kind (phase-3-errors AC4). */
export const COOLDOWN_MS: Readonly<Partial<Record<CliFailureKind, number>>> = {
  'not-logged-in': 60_000,
  limit: 5 * 60_000,
};

/**
 * Backends that get no automatic inline request for a while after a `not-logged-in` or `limit`
 * failure, so that typing does not start a failing CLI per pause (phase-3-errors AC4). A settings
 * change and the manual trigger clear it.
 */
export class Cooldowns {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts a cool-down for `backend` when `kind` has one. */
  start(backend: string, kind: CliFailureKind): void {
    const ms = COOLDOWN_MS[kind];
    if (ms !== undefined) this.until.set(backend, this.now() + ms);
  }

  /** Whether `backend` is cooling down now. */
  active(backend: string): boolean {
    const until = this.until.get(backend);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.until.delete(backend);
    return false;
  }

  clear(): void {
    this.until.clear();
  }
}

/** Explicit triggers (Alt+\) never wait. */
export function debounceFor(
  settings: InlineSettings,
  backend: BackendId,
  automatic: boolean,
): number {
  if (!automatic) return 0;
  if (settings.debounceMs !== null) return Math.max(0, settings.debounceMs);
  return CLI_BACKENDS.has(backend) ? CLI_DEBOUNCE_MS : LOCAL_DEBOUNCE_MS;
}
