// Chat models reported by the CLIs themselves (docs/plans/phase-4-models.md). vscode-free.
//
// Only the fields named in M2 are read, and the name prefix of a Claude model's `description`
// (phase-4-picker.md U7). Claude's `initialize` answer also holds the account, the
// commands and more, and Codex's catalog holds each model's base instructions: none of that
// leaves the parsers, and nothing raw is logged or stored.
import { isModelId, windowOf } from './models';

export interface EffortLevel {
  /** The value the CLI takes (`--effort` / `model_reasoning_effort`). */
  id: string;
  description?: string;
}

export interface DiscoveredModel {
  /** The id the CLI takes with `--model` / `-m`. */
  id: string;
  /** The CLI's own name for it (`Sonnet 5.5`, `GPT-6-Luna`). */
  displayName: string;
  /** The effort levels the model takes (phase-4-effort.md E1, E4). */
  efforts?: EffortLevel[];
  /** The level the CLI uses by default (Codex reports it; Claude does not). */
  defaultEffort?: string;
  /** The model's context window in tokens (Codex reports it; E3). */
  contextWindow?: number;
  /** Codex's largest window for the model (`max_context_window`; phase-4-context.md W5). */
  maxContextWindow?: number;
}

export type DiscoveryCli = 'claude' | 'codex';

/**
 * The effort levels each CLI is known to take (E4): Claude Code 2.1.312's `--effort` (`--help`),
 * and the levels of codex-cli 0.164.0's catalog. Anything else is dropped.
 */
const KNOWN_EFFORTS: Record<DiscoveryCli, ReadonlySet<string>> = {
  claude: new Set(['low', 'medium', 'high', 'xhigh', 'max']),
  codex: new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
};
const MAX_DESCRIPTION = 200;

function effortsOf(
  cli: DiscoveryCli,
  entries: unknown,
  idOf: (entry: unknown) => unknown,
  descriptionOf: (entry: unknown) => unknown,
): EffortLevel[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const result: EffortLevel[] = [];
  for (const entry of entries) {
    const id = idOf(entry);
    if (typeof id !== 'string' || !KNOWN_EFFORTS[cli].has(id)) continue;
    if (result.some((level) => level.id === id)) continue;
    const text = descriptionOf(entry);
    const description =
      typeof text === 'string' && text.trim() !== ''
        ? text.trim().slice(0, MAX_DESCRIPTION)
        : undefined;
    result.push(description ? { id, description } : { id });
  }
  return result.length > 0 ? result : undefined;
}

/** A model with only the fields that are set (undefined ones left out). */
function modelOf(
  id: string,
  displayName: string,
  efforts: EffortLevel[] | undefined,
  defaultEffort: unknown,
  contextWindow: number | undefined,
  maxContextWindow?: number,
): DiscoveredModel {
  const model: DiscoveredModel = { id, displayName };
  if (efforts) model.efforts = efforts;
  if (typeof defaultEffort === 'string' && efforts?.some((level) => level.id === defaultEffort)) {
    model.defaultEffort = defaultEffort;
  }
  if (contextWindow !== undefined) model.contextWindow = contextWindow;
  if (maxContextWindow !== undefined) model.maxContextWindow = maxContextWindow;
  return model;
}

/** Why a probe gave no list (logged as a kind only, never with CLI output). */
export type DiscoveryFailure = 'not-installed' | 'timeout' | 'exit' | 'no-models' | 'unreadable';

const MAX_DISPLAY_NAME = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayNameOf(value: unknown, id: string): string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_DISPLAY_NAME
    ? value.trim()
    : id;
}

/**
 * Claude's name with its version (phase-4-picker.md U7): with nonessential traffic off, Claude
 * Code 2.1.312 names a model "Opus" and starts its description with the full name, "Opus 5.5 · …".
 * That prefix replaces the name only when it extends it; nothing else of the description is kept.
 */
export function versionedName(displayName: string, description: unknown): string {
  if (typeof description !== 'string') return displayName;
  const at = description.indexOf(' · ');
  if (at <= 0) return displayName;
  const prefix = description.slice(0, at).trim();
  return prefix.length <= MAX_DISPLAY_NAME && prefix.startsWith(`${displayName} `)
    ? prefix
    : displayName;
}

/**
 * The models of a Claude `control_response` to `initialize` (M1, M2): every `models` entry except
 * `default` (the same model as `opus`), by `value`. Undefined when `line` is not that answer; an
 * empty list when it is, without usable models.
 */
export function claudeModelsFromLine(line: string): DiscoveredModel[] | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(event) || event.type !== 'control_response') return undefined;
  const outer = isObject(event.response) ? event.response : undefined;
  const inner = outer && isObject(outer.response) ? outer.response : undefined;
  const models = inner?.models;
  const result: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(models) ? models : []) {
    if (!isObject(entry)) continue;
    const id = entry.value;
    if (typeof id !== 'string' || id === 'default' || !isModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const efforts = effortsOf(
      'claude',
      entry.supportedEffortLevels,
      (level) => level,
      () => undefined,
    );
    const name = versionedName(displayNameOf(entry.displayName, id), entry.description);
    result.push(modelOf(id, name, efforts, undefined, undefined));
  }
  return result;
}

/**
 * The models of `codex debug models` (M1, M2): the entries with `visibility: "list"`, as in
 * Codex's own picker, ordered by `priority`, by `slug`. Undefined when the text is not the catalog.
 */
export function codexModelsFromCatalog(text: string): DiscoveredModel[] | undefined {
  let catalog: unknown;
  try {
    catalog = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(catalog) || !Array.isArray(catalog.models)) return undefined;
  const listed: { model: DiscoveredModel; priority: number; at: number }[] = [];
  const seen = new Set<string>();
  catalog.models.forEach((entry: unknown, at: number) => {
    if (!isObject(entry) || entry.visibility !== 'list') return;
    const id = entry.slug;
    if (typeof id !== 'string' || !isModelId(id) || seen.has(id)) return;
    seen.add(id);
    const priority =
      typeof entry.priority === 'number' && Number.isFinite(entry.priority)
        ? entry.priority
        : Number.POSITIVE_INFINITY;
    const efforts = effortsOf(
      'codex',
      entry.supported_reasoning_levels,
      (level) => (isObject(level) ? level.effort : undefined),
      (level) => (isObject(level) ? level.description : undefined),
    );
    const model = modelOf(
      id,
      displayNameOf(entry.display_name, id),
      efforts,
      entry.default_reasoning_level,
      windowOf(entry.context_window),
      windowOf(entry.max_context_window),
    );
    listed.push({ model, priority, at });
  });
  listed.sort((a, b) => a.priority - b.priority || a.at - b.at);
  return listed.map((entry) => entry.model);
}

/**
 * The discovered models, then the configured ids they do not include (M1): a typed full id, or one
 * that `chat.utilityModel` names, stays offered.
 */
export function mergeModels(
  discovered: readonly DiscoveredModel[],
  configured: readonly string[],
): DiscoveredModel[] {
  const result = [...discovered];
  const seen = new Set(discovered.map((model) => model.id));
  for (const raw of configured) {
    const id = raw.trim();
    if (!isModelId(id) || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, displayName: id });
  }
  return result;
}

/**
 * A stored list, checked again: `globalState` is data from disk (M2, M4, E4). A list stored before
 * effort levels existed (ids and names only) reads as models without levels.
 */
export function sanitizeStored(value: unknown, cli: DiscoveryCli): DiscoveredModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isObject(entry) || typeof entry.id !== 'string') continue;
    if (!isModelId(entry.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const efforts = effortsOf(
      cli,
      entry.efforts,
      (level) => (isObject(level) ? level.id : undefined),
      (level) => (isObject(level) ? level.description : undefined),
    );
    result.push(
      modelOf(
        entry.id,
        displayNameOf(entry.displayName, entry.id),
        efforts,
        entry.defaultEffort,
        windowOf(entry.contextWindow),
        windowOf(entry.maxContextWindow),
      ),
    );
  }
  return result.length > 0 ? result : undefined;
}

/** How long a list is used before the CLI is asked again (M4). */
export const DISCOVERY_TTL_MS = 10 * 60_000;
/** How long a failed probe is not repeated (the last good list is used meanwhile). */
export const FAILURE_TTL_MS = 60_000;
/**
 * A shorter answer that only drops models of the last good list is taken on its third time in a
 * row; until then the last list stays and the CLI is asked again after this delay. Claude Code
 * 2.1.312 sometimes answers `initialize` with its three aliases only, without the privacy
 * variable, where it otherwise lists twelve (the user's VS Code on 2026-10-30, 01:54 and 10:56).
 */
export const SHRINK_RETRY_MS = 2 * 60_000;
export const SHRINK_CONFIRMATIONS = 3;

export interface DiscoveryStore {
  get(key: string): unknown;
  set(key: string, models: DiscoveredModel[]): void;
}

export interface ModelDiscoveryDeps {
  probe(cli: DiscoveryCli, path: string): Promise<DiscoveredModel[] | DiscoveryFailure>;
  /** The last good list per CLI and path, kept across sessions (ids and display names only). */
  store?: DiscoveryStore;
  /** A fresh list differs from the one used before: the picker should ask again. */
  onChange(): void;
  /**
   * What of the settings a probe runs under shapes the CLI's answer: for Claude, its privacy
   * setting (three models instead of twelve). Read right before each probe; when it differs from
   * the one the last list was taken under, a shorter answer is taken at once (P4DF-006).
   */
  environment?(cli: DiscoveryCli): string;
  log(event: {
    cli: DiscoveryCli;
    models?: number;
    failure?: DiscoveryFailure;
    /** A shorter answer was not taken yet: the size of the list kept. */
    kept?: number;
    ms: number;
  }): void;
  now?(): number;
}

interface Entry {
  /** When the last probe finished. */
  at: number;
  ttl: number;
  pending?: Promise<void>;
  /** The `invalidate()` generation the probe belongs to (inspection P4M-I001). */
  generation: number;
}

/**
 * The discovered models per CLI and executable path (M4, M5): probed when first asked for, again
 * after `invalidate()` or the TTL; one probe at a time per key. A stored list answers at once while
 * a probe runs; without one, the first call waits for the probe (bounded by its timeout).
 */
export class ModelDiscovery {
  private readonly entries = new Map<string, Entry>();
  private readonly lists = new Map<string, DiscoveredModel[]>();
  /** Bumped by `invalidate()` and `clear()`: an older probe's result is dropped. */
  private generation = 0;
  /** The probe running per key, of any generation: at most one process each (P4M-RI001). */
  private readonly running = new Map<string, Promise<void>>();
  /** Shorter answers in a row per key (SHRINK_CONFIRMATIONS). */
  private readonly shorter = new Map<string, number>();
  /**
   * The `environment` each key's list was taken under in this session. A shorter answer under
   * another environment is a real change, so it bypasses the guard (P4DF-004–P4DF-006).
   */
  private readonly environments = new Map<string, string>();

  constructor(private readonly deps: ModelDiscoveryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The last good list, from this session or the store. */
  private lastGood(key: string): DiscoveredModel[] | undefined {
    const known = this.lists.get(key);
    if (known) return known;
    const cli: DiscoveryCli = key.startsWith('codex:') ? 'codex' : 'claude';
    const stored = sanitizeStored(this.deps.store?.get(key), cli);
    if (stored) this.lists.set(key, stored);
    return stored;
  }

  async models(cli: DiscoveryCli, path: string): Promise<DiscoveredModel[] | undefined> {
    const key = `${cli}:${path}`;
    for (;;) {
      // An entry of an older generation (settings changed since) counts as none: its probe may
      // still run, but its result is dropped (P4M-I001).
      const found = this.entries.get(key);
      const entry = found?.generation === this.generation ? found : undefined;
      const last = this.lastGood(key);
      if (entry?.pending) {
        if (last) return last;
        await entry.pending;
        return this.lastGood(key);
      }
      if (entry && this.now() - entry.at < entry.ttl) return last;
      // A probe of older settings still runs: the new one starts only after it, so there is
      // never more than one process per CLI and path (P4M-RI001).
      const older = this.running.get(key);
      if (older) {
        if (last) {
          void older.then(() => this.models(cli, path));
          return last;
        }
        await older;
        continue;
      }
      const generation = this.generation;
      const pending = this.probe(cli, path, key, generation);
      this.running.set(key, pending);
      void pending.finally(() => {
        if (this.running.get(key) === pending) this.running.delete(key);
      });
      this.entries.set(key, { at: entry?.at ?? 0, ttl: entry?.ttl ?? 0, pending, generation });
      if (last) return last;
      await pending;
      return this.lastGood(key);
    }
  }

  private async probe(
    cli: DiscoveryCli,
    path: string,
    key: string,
    generation: number,
  ): Promise<void> {
    const started = this.now();
    // Read with no await before the probe starts, so it is the environment the probe runs under.
    const environment = this.deps.environment?.(cli) ?? '';
    let result: DiscoveredModel[] | DiscoveryFailure;
    try {
      result = await this.deps.probe(cli, path);
    } catch {
      result = 'unreadable';
    }
    const ms = this.now() - started;
    if (generation !== this.generation) {
      // Settings changed while it ran: the result may belong to the old ones.
      if (this.entries.get(key)?.generation === generation) this.entries.delete(key);
      return;
    }
    if (typeof result === 'string' || result.length === 0) {
      // A failure interrupts a run of shorter answers (inspection P4DF-003).
      this.shorter.delete(key);
      const failure = typeof result === 'string' ? result : 'no-models';
      this.deps.log({ cli, failure, ms });
      this.entries.set(key, { at: this.now(), ttl: FAILURE_TTL_MS, generation });
      return;
    }
    const before = this.lastGood(key);
    const known = new Set((before ?? []).map((model) => model.id));
    // Claude only: a shorter Codex catalog is a real change (inspection P4DF-002).
    const shrank =
      cli === 'claude' &&
      (this.environments.get(key) ?? environment) === environment &&
      before !== undefined &&
      result.length < before.length &&
      result.every((model) => known.has(model.id));
    const times = shrank ? (this.shorter.get(key) ?? 0) + 1 : 0;
    if (shrank && times < SHRINK_CONFIRMATIONS) {
      // Possibly a transient short answer: the last list stays, and the CLI is asked again soon.
      this.shorter.set(key, times);
      this.deps.log({ cli, models: result.length, kept: before.length, ms });
      this.entries.set(key, { at: this.now(), ttl: SHRINK_RETRY_MS, generation });
      return;
    }
    this.shorter.delete(key);
    this.environments.set(key, environment);
    this.deps.log({ cli, models: result.length, ms });
    this.lists.set(key, result);
    this.deps.store?.set(key, result);
    this.entries.set(key, { at: this.now(), ttl: DISCOVERY_TTL_MS, generation });
    if (!sameModels(before, result)) this.deps.onChange();
  }

  /** Forgets everything of this session (tests; the store is cleared by its owner). */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.lists.clear();
    this.shorter.clear();
    this.environments.clear();
  }

  /**
   * Settings or trust changed: the next call probes again, and a probe still running belongs to
   * the old settings, so its result is dropped (P4M-I001). The lists stay as fallback.
   */
  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.shorter.clear();
  }
}

/** Every kept field of a model, in a fixed order (E7: a change of any of them counts). */
function fingerprint(model: DiscoveredModel): string {
  return JSON.stringify([
    model.id,
    model.displayName,
    (model.efforts ?? []).map((level) => [level.id, level.description ?? '']),
    model.defaultEffort ?? '',
    model.contextWindow ?? 0,
    model.maxContextWindow ?? 0,
  ]);
}

function sameModels(
  a: readonly DiscoveredModel[] | undefined,
  b: readonly DiscoveredModel[],
): boolean {
  return (
    a !== undefined &&
    a.length === b.length &&
    a.every((model, i) => fingerprint(model) === fingerprint(b[i]!))
  );
}
