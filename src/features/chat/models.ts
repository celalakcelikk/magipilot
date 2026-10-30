// Chat model list from settings and gates (docs/plans/phase-2.md D1, D5, D6, D7). vscode-free.

export type ChatBackendId = 'claude-cli' | 'codex-cli';

/**
 * The vendor each CLI's models are registered under: one tab each in VS Code's model picker
 * (docs/plans/phase-4-context.md G1, D1). Claude keeps `magipilot`, so its identifiers
 * (`magipilot/claude-cli.<model>`: pins, selections, utility settings) stay valid.
 */
const VENDORS: Record<ChatBackendId, string> = {
  'claude-cli': 'magipilot',
  'codex-cli': 'magipilot-codex',
};

export function vendorOf(backend: ChatBackendId): string {
  return VENDORS[backend];
}

/**
 * The windows Magipilot takes from a CLI, the store or a setting (phase-4-context.md W1, W3, W4).
 * The floor keeps every budget positive (plan review P4CTX-R001): a smaller window counts as none.
 */
export const MIN_WINDOW = 64_000;
export const MAX_WINDOW = 2_000_000;

export function windowOf(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_WINDOW &&
    value <= MAX_WINDOW
    ? value
    : undefined;
}

export interface ChatModelDescriptor {
  /** `claude-cli.<model>` / `codex-cli.<model>`: no `/`, which separates `<vendor>/<id>`. */
  id: string;
  backend: ChatBackendId;
  /** The vendor it is registered under (`vendorOf(backend)`). */
  vendor: string;
  /** The CLI's model id or alias (`--model` / `-m`). */
  model: string;
  name: string;
  family: ChatBackendId;
  detail: string;
  tooltip: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** The model's context window, shown by VS Code (phase-4-effort.md E3; phase-4-context.md W3). */
  maxContextWindowTokens: number;
  /**
   * Codex's `model_context_window` for this model's calls: set only when the user opted into the
   * largest catalog window and it exceeds the default (phase-4-context.md W5).
   */
  cliContextWindow?: number;
  /**
   * The smaller context sizes the user may choose (docs/plans/phase-4-sizes.md S1); empty when the
   * full size is the only one.
   */
  contextTiers: readonly number[];
  /**
   * The model's settings in VS Code's picker (phase-4-effort.md E1, phase-4-picker.md U1, U2,
   * phase-4-sizes.md S1): the effort choice, when the model has levels, and its context size.
   */
  configurationSchema?: ModelConfigurationSchema;
}

/**
 * The shape VS Code 1.144 reads from a provider's model information. A property shows in the
 * label beside the model and on its card only with its `group`: `navigation` for the effort,
 * `tokens` for the context size, as Copilot's own models declare them (phase-4-picker.md §1).
 * The context size is `contextTier`, which VS Code shows like `contextSize` but Copilot Chat does
 * not apply, so a chosen size is Magipilot's alone (phase-4-sizes.md D7, plan review
 * P4SIZE-R001).
 */
export interface ModelConfigurationSchema {
  properties: {
    reasoningEffort?: {
      type: 'string';
      title: string;
      enum: string[];
      enumItemLabels: string[];
      enumDescriptions: string[];
      default?: string;
      group: 'navigation';
    };
    contextTier?: {
      type: 'number';
      title: string;
      enum: number[];
      enumItemLabels: string[];
      enumDescriptions: string[];
      default: number;
      readOnly?: true;
      group: 'tokens';
    };
  };
}

/** A model to offer: an id, with what discovery found about it. */
export interface ModelEntry {
  id: string;
  displayName?: string;
  efforts?: readonly { id: string; description?: string }[];
  defaultEffort?: string;
  contextWindow?: number;
  /** Codex's largest catalog window (phase-4-context.md W5). */
  maxContextWindow?: number;
}

/** Claude's choice that adds no `--effort`: the CLI decides (D2). */
export const AUTO_EFFORT = 'auto';

const EFFORT_LABELS: Record<string, string> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

/** The picker's effort choice for a model with levels (E1, U2); none without. */
export function effortSchema(
  backend: ChatBackendId,
  entry: ModelEntry,
): ModelConfigurationSchema | undefined {
  const levels = entry.efforts ?? [];
  if (levels.length === 0) return undefined;
  const items =
    backend === 'claude-cli'
      ? [{ id: AUTO_EFFORT, description: 'Claude Code decides (no --effort)' }, ...levels]
      : [...levels];
  const fallback = backend === 'claude-cli' ? AUTO_EFFORT : entry.defaultEffort;
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        // VS Code's and Copilot's own name for it (U2).
        title: 'Effort Level',
        enum: items.map((item) => item.id),
        enumItemLabels: items.map((item) => EFFORT_LABELS[item.id] ?? item.id),
        enumDescriptions: items.map((item) => item.description ?? ''),
        ...(fallback !== undefined ? { default: fallback } : {}),
        group: 'navigation',
      },
    },
  };
}

/**
 * The effort of one request (E2): the picker's choice when the model offers it, else the
 * schema's default; `auto` and anything unknown mean none (the CLI's own default, or for Codex
 * the `fallback` setting).
 */
export function effortFor(
  schema: ModelConfigurationSchema | undefined,
  chosen: unknown,
): string | undefined {
  const effort = schema?.properties.reasoningEffort;
  if (!effort) return undefined;
  const pick = typeof chosen === 'string' && effort.enum.includes(chosen) ? chosen : effort.default;
  return pick === undefined || pick === AUTO_EFFORT ? undefined : pick;
}

/**
 * `242K`, `1M`: a size as VS Code itself formats one (its `mx`, used for Manage Models' "Context
 * Size" column), so every view shows the same text (phase-4-picker.md U1, U6).
 */
export function windowLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.floor((tokens / 1_000_000) * 10) / 10;
    return millions % 1 === 0 ? `${millions.toFixed(0)}M` : `${millions.toFixed(1)}M`;
  }
  if (tokens > 900_000) return '1M';
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

const CLI_NAME: Record<ChatBackendId, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex',
};

/** The smaller sizes a user may choose, each kept when it is at most 80 % of a model's size (S1). */
const CONTEXT_TIERS = [128_000, 200_000] as const;
const TIER_SHARE = 0.8;

/** The tiers a model of advertised `size` offers (S1). */
export function contextTiersFor(size: number): number[] {
  return CONTEXT_TIERS.filter((tier) => tier <= size * TIER_SHARE);
}

/**
 * The "Context Size" of a model (phase-4-picker.md U1, phase-4-sizes.md S1): its tiers, then its
 * advertised size, the default. VS Code labels the chosen one without "Max". The full size's
 * description names the CLI's own window (`full`) and the user's limit; read-only without tiers.
 */
export function contextTierProperty(
  backend: ChatBackendId,
  size: number,
  full: number,
  limited: number | undefined,
  tiers: readonly number[],
): NonNullable<ModelConfigurationSchema['properties']['contextTier']> {
  return {
    type: 'number',
    title: 'Context Size',
    enum: [...tiers, size],
    enumItemLabels: [...tiers, size].map(windowLabel),
    enumDescriptions: [...tiers.map(tierText), usableText(backend, size, full, limited)],
    default: size,
    ...(tiers.length === 0 ? { readOnly: true as const } : {}),
    group: 'tokens',
  };
}

/** What a tier does (S1, S3, S9, D5). */
function tierText(tier: number): string {
  return `Magipilot keeps the conversation within about ${windowLabel(tier)} tokens (it counts each byte as a token, so usually fewer) by leaving the oldest messages out. In Ask mode Copilot Chat itself already sends only about the last five questions, so this matters most with large messages or attachments. Copilot Chat's own instructions and tools are sent in full, and a single message larger than that is sent without older messages. Uses less of your plan's quota.`;
}

/**
 * The tier a request uses (S2): the chosen value when it is one of the model's tiers now, else
 * none, which is the full size. A stale or foreign value never becomes a smaller cap (D6).
 */
export function chosenTier(tiers: readonly number[], chosen: unknown): number | undefined {
  return typeof chosen === 'number' && tiers.includes(chosen) ? chosen : undefined;
}

/**
 * What the advertised size is (U6): input and the answer reserve, out of the CLI's own window,
 * and the user's limit when it applies (inspection P4PICK-I002).
 */
function usableText(backend: ChatBackendId, size: number, full: number, limited?: number): string {
  const cli = CLI_NAME[backend];
  const limit =
    limited !== undefined && limited < full
      ? `, limited to ${windowLabel(limited)} by magipilot.chat.contextWindowLimit`
      : '';
  return `Magipilot can use about ${Math.round(size / 1000)}K tokens, the answer included, of the ${windowLabel(full)} window that ${cli} reports${limit}; the rest is kept for ${cli}'s own instructions.`;
}

export interface ChatModelSettings {
  claudeModels: readonly (string | ModelEntry)[];
  codexModels: readonly (string | ModelEntry)[];
  /** `magipilot.chat.contextWindowLimit` (W4): caps every window; outside 64K–2M it is none. */
  windowLimit?: number | null;
  /** `magipilot.chat.codex.maxContextWindow` (W5). */
  codexMaxWindow?: boolean;
}

export interface ChatGates {
  trusted: boolean;
  platform: NodeJS.Platform;
  claudeAvailable: boolean;
  codexAvailable: boolean;
}

/**
 * D7: context window − output reserve − the CLI's own instructions − conversion overhead.
 * `cli` is what the CLI adds to every prompt on its own, which the byte estimate of Magipilot's
 * text does not see (docs/plans/phase-4-tokens.md, plan review P4TOK-R001). It is measured with
 * Magipilot's isolation flags: Codex's base instructions with the lean profile came to about
 * 11 100 input tokens for an empty sample (phase-2-review.md P11) and 11 200 for a short prompt
 * (phase-4-tools.md recon); Claude's whole call for an empty sample came to 659 (P11) and 1 584
 * with `--json-schema` and a one-tool catalogue (S1). Both are rounded up.
 */
const LIMITS: Record<ChatBackendId, { context: number; output: number; cli: number }> = {
  'claude-cli': { context: 200_000, output: 32_000, cli: 2_000 },
  'codex-cli': { context: 128_000, output: 16_000, cli: 12_000 },
};
export const CONVERSION_RESERVE = 4_000;
/**
 * The share of the window a prompt may fill (W3): Codex uses 95 % of a model's window
 * (`effective_context_window_percent`, 95 for every listed model of codex-cli 0.164.0).
 */
const USABLE: Record<ChatBackendId, number> = { 'claude-cli': 1, 'codex-cli': 0.95 };
/**
 * The longest prompt a CLI takes. codex-cli 0.164.0 refuses a user input over 1 048 576 characters
 * before sending it ("Input exceeds the maximum length of 1048576 characters", measured on
 * 2026-10-30). A budget in Magipilot's tokens (UTF-8 bytes, never fewer than characters) up to
 * that size can never exceed it (phase-4-context.md, build).
 */
const MAX_PROMPT: Record<ChatBackendId, number> = {
  'claude-cli': Number.POSITIVE_INFINITY,
  'codex-cli': 1_048_576,
};

/**
 * Whether a CLI's models declare tool calling when `magipilot.chat.toolCalling` is on. Measured on
 * 2026-10-29 (docs/bench.md, "Faz 4 — tool calling"): Claude called the offered tool in every run
 * (4 of 4), Codex in none (0 of 4) with Copilot Chat's agent-mode tool list. So Codex does not
 * declare it until its prompt is made to work (Codex inspection P4T-REV-002); its structured path
 * stays in place, covered by tests and `cli:verify --only structured`.
 */
const TOOL_CALLING: Record<ChatBackendId, boolean> = {
  'claude-cli': true,
  'codex-cli': false,
};

export function supportsToolCalling(backend: ChatBackendId): boolean {
  return TOOL_CALLING[backend];
}

/** Tokens the CLI adds to every prompt on its own (see LIMITS). */
export function cliOverhead(backend: ChatBackendId): number {
  return LIMITS[backend].cli;
}

const LABEL: Record<ChatBackendId, string> = {
  'claude-cli': 'Claude (CLI)',
  'codex-cli': 'Codex (CLI)',
};

/** Model ids are passed to the CLI as one argument; anything unusual is skipped. */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** Whether a string can be a model id (it goes into a command line as one argument). */
export function isModelId(id: string): boolean {
  return MODEL_ID.test(id);
}

/** The window assumed for a model whose CLI reported none (Claude 200 000, Codex 128 000). */
export function assumedWindow(backend: ChatBackendId): number {
  return LIMITS[backend].context;
}

/** `maxInputTokens` of a model with `window` (W3); positive for every window from 64 000. */
export function maxInputTokens(backend: ChatBackendId, window = LIMITS[backend].context): number {
  return promptBudget(backend, window) - CONVERSION_RESERVE;
}

/**
 * What Magipilot's whole CLI prompt may hold: the usable window less the output reserve and the
 * CLI's own instructions, i.e. the advertised `maxInputTokens` plus the conversion reserve
 * (phase-4-tools.md T13b, phase-4-tokens.md, phase-4-context.md W3).
 */
export function promptBudget(backend: ChatBackendId, window = LIMITS[backend].context): number {
  return Math.min(
    Math.floor(window * USABLE[backend]) - LIMITS[backend].output - LIMITS[backend].cli,
    MAX_PROMPT[backend],
  );
}

/**
 * The size gate's budget for a request (T13b, W3): the requested model's own `maxInputTokens`, as
 * VS Code passes it back, plus the conversion reserve; the CLI's default when that is unusable.
 */
export function requestBudget(backend: ChatBackendId, advertised: unknown): number {
  return typeof advertised === 'number' && Number.isInteger(advertised) && advertised > 0
    ? advertised + CONVERSION_RESERVE
    : promptBudget(backend);
}

/**
 * A model's window (W3, W4, W5): the read or catalog window, else the CLI's assumed one; for Codex
 * with the opt-in, its largest catalog window; then the cap. `cli` is Codex's
 * `model_context_window`, set only when the window used exceeds Codex's default.
 */
export function modelWindow(
  backend: ChatBackendId,
  entry: ModelEntry,
  settings: Pick<ChatModelSettings, 'windowLimit' | 'codexMaxWindow'>,
): { window: number; cli?: number } {
  const standard = windowOf(entry.contextWindow) ?? LIMITS[backend].context;
  const largest =
    backend === 'codex-cli' && settings.codexMaxWindow === true
      ? windowOf(entry.maxContextWindow)
      : undefined;
  const chosen = largest !== undefined && largest > standard ? largest : standard;
  const limit = windowOf(settings.windowLimit);
  const window = limit !== undefined ? Math.min(chosen, limit) : chosen;
  return largest !== undefined && window > standard ? { window, cli: window } : { window };
}

function descriptors(
  backend: ChatBackendId,
  models: readonly (string | ModelEntry)[],
  settings: Pick<ChatModelSettings, 'windowLimit' | 'codexMaxWindow'>,
): ChatModelDescriptor[] {
  const seen = new Set<string>();
  const result: ChatModelDescriptor[] = [];
  for (const raw of models) {
    const model = (typeof raw === 'string' ? raw : raw.id).trim();
    if (!MODEL_ID.test(model) || seen.has(model)) continue;
    seen.add(model);
    // The CLI's own name (`Opus 5.5`), else the id: the user's choice of 2026-10-29, over loop
    // 5's `<CLI> · <id>` (P4M-R001). VS Code stores some selections by name, so one made under the
    // old name has to be made again once (phase-4-effort review log).
    const entry: ModelEntry = typeof raw === 'string' ? { id: model } : raw;
    const shown = entry.displayName?.trim();
    const named = shown !== undefined && shown !== '' && shown !== model ? shown : undefined;
    // The window the CLI reports, else the one assumed for it (E3), and the budgets that follow
    // from it (phase-4-context.md W3, D4: loop 6's fixed budgets are gone).
    const { window, cli } = modelWindow(backend, entry, settings);
    // The CLI's own window, without the user's limit, for the texts (P4PICK-I002).
    const full = modelWindow(backend, entry, { ...settings, windowLimit: null }).window;
    const input = maxInputTokens(backend, window);
    const output = LIMITS[backend].output;
    // The size advertised everywhere is what Copilot can use: Manage Models' own sum of input and
    // output (phase-4-picker.md U6, plan review P4PICK-R002); the CLI's window drives the budgets.
    const size = input + output;
    const tiers = contextTiersFor(size);
    const effort = effortSchema(backend, entry);
    result.push({
      id: `${backend}.${model}`,
      backend,
      vendor: vendorOf(backend),
      model,
      name: named ?? model,
      family: backend,
      detail: windowLabel(size),
      tooltip: `${LABEL[backend]} with model "${model}"${named ? ` (${named})` : ''}. ${usableText(backend, size, full, window)} Runs the local CLI without tools of its own.`,
      maxInputTokens: input,
      maxOutputTokens: output,
      maxContextWindowTokens: size,
      ...(cli !== undefined ? { cliContextWindow: cli } : {}),
      contextTiers: tiers,
      configurationSchema: {
        properties: {
          ...effort?.properties,
          contextTier: contextTierProperty(backend, size, full, window, tiers),
        },
      },
    });
  }
  return result;
}

/** The models to show (D6): only where CLIs may run and the CLI is installed. */
export function chatModels(settings: ChatModelSettings, gates: ChatGates): ChatModelDescriptor[] {
  if (!gates.trusted || gates.platform === 'win32') return [];
  const models = [
    ...(gates.claudeAvailable ? descriptors('claude-cli', settings.claudeModels, settings) : []),
    ...(gates.codexAvailable ? descriptors('codex-cli', settings.codexModels, settings) : []),
  ];
  // A name two models share gets the model's id; one that still collides (the same id in both
  // CLIs) gets the backend-qualified id (inspection P4E-I002), checked against every name in the
  // list, kept or made, with a number as the last resort (P4E-I003).
  const counts = (list: readonly ChatModelDescriptor[]): Map<string, number> => {
    const count = new Map<string, number>();
    for (const model of list) count.set(model.name, (count.get(model.name) ?? 0) + 1);
    return count;
  };
  const first = counts(models);
  const once = models.map((model) =>
    (first.get(model.name) ?? 0) > 1 && model.name !== model.model
      ? { ...model, name: `${model.name} (${model.model})` }
      : model,
  );
  const second = counts(once);
  const used = new Set<string>();
  return once.map((model) => {
    let name = model.name;
    if ((second.get(name) ?? 0) > 1 || used.has(name)) {
      const base = `${model.name} (${model.id})`;
      name = base;
      for (let n = 2; used.has(name) || second.has(name); n++) name = `${base} ${n}`;
    }
    used.add(name);
    return name === model.name ? model : { ...model, name };
  });
}

/**
 * The current value for one this command wrote before Codex models had their own vendor
 * (`magipilot/codex-cli.<model>`, phase-4-context.md G2); undefined for any other value.
 */
export function migratedUtilityValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^magipilot\/codex-cli\.(.+)$/.exec(value);
  if (!match || !isModelId(match[1]!)) return undefined;
  return `${vendorOf('codex-cli')}/codex-cli.${match[1]}`;
}

/** `claude-cli.sonnet` → { backend, model }; undefined for anything else (echo models, …). */
export function parseChatModelId(
  id: string,
): { backend: ChatBackendId; model: string } | undefined {
  for (const backend of ['claude-cli', 'codex-cli'] as const) {
    const prefix = `${backend}.`;
    if (id.startsWith(prefix)) {
      const model = id.slice(prefix.length);
      return MODEL_ID.test(model) ? { backend, model } : undefined;
    }
  }
  return undefined;
}

/** Values of one setting by scope, as `WorkspaceConfiguration.inspect()` returns them. */
export interface ScopedValues<T> {
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * The scope whose value keeps a user-level `value` from taking effect, or undefined when `value`
 * wins (plan review P2-R003). A folder value has the highest precedence: when it equals `value`,
 * a different workspace value is shadowed and does not matter (inspection P2-I002).
 */
export function overridingScope<T>(
  values: ScopedValues<T> | undefined,
  value: T,
): 'Workspace Folder' | 'Workspace' | undefined {
  if (values?.workspaceFolderValue !== undefined) {
    return values.workspaceFolderValue === value ? undefined : 'Workspace Folder';
  }
  if (values?.workspaceValue !== undefined && values.workspaceValue !== value) return 'Workspace';
  return undefined;
}
