// Copilot Chat model provider (PLAN §7, docs/plans/phase-2.md). Ask mode by default: the models
// declare tool calling only with `magipilot.chat.toolCalling` (docs/plans/phase-4-tools.md), and
// then report the CLI's structured answer as tool call parts that Copilot Chat runs. Requests go to
// the CLI backends (isolated, no tools of their own, empty temp cwd); cancellation aborts the CLI
// process.
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ClaudeCliBackend } from '../../core/backends/claudeCli';
import { CodexCliBackend } from '../../core/backends/codexCli';
import {
  InvalidAnswerError,
  isStructuredChatBackend,
  validateToolCalls,
} from '../../core/backends/structured';
import type { Backend } from '../../core/backends/types';
import type { Effort } from '../../core/process/cliArgs';
import { probeExecutable, type ProcessRegistry } from '../../core/process/runner';
import type { EchoChatProvider } from '../../spike/echoProvider';
import type { Log } from '../../ui/log';
import { platformExcludeOptions } from '../../core/context/exclude';
import { failureMessage, isCliFailure, type CliName } from '../../core/backends/failures';
import { ChatStats } from '../../metrics';
import { redactExcludedLines, type ExcludedContent } from './contentGuard';
import { exchangeStarts, trimNotice, trimToTier } from './contextTrim';
import { readStable } from './indexCache';
import {
  allIdOnlyNames,
  assembleCliPrompt,
  COUNTING_NONCE,
  estimateTokens,
  filterTurns,
  filterTurnText,
  idOnlyNamesForRequest,
  newToolNonce,
  NON_TEXT_PART,
  minimumTokens,
  renderMessage,
  toolTurns,
  type ChatTurn,
  type CliPromptOptions,
  type MessagePart,
  type PathKind,
  type RequestMessage,
} from './messages';
import {
  chatModels,
  chosenTier,
  parseChatModelId,
  requestBudget,
  supportsToolCalling,
  type ChatBackendId,
  type ChatModelDescriptor,
  effortFor,
  type ModelConfigurationSchema,
} from './models';
import { commandValues, inputExcluded, isCommandValue } from './toolInput';
import { mergeModels, type DiscoveredModel } from './modelDiscovery';

/** Per-request limit for chat (D9); Copilot's own cancel usually comes first. */
export const CHAT_TIMEOUT_MS = 10 * 60_000;
const ECHO_PREFIX = 'magipilot-echo';
const AVAILABILITY_TTL_MS = 60_000;

export interface ChatSettings {
  claudeModels: string[];
  codexModels: string[];
  claudePath: string;
  codexPath: string;
  codexEffort: Effort;
  disableNonessentialTraffic: boolean;
  /** `magipilot.chat.toolCalling` (phase-4-tools.md T1). */
  toolCalling: boolean;
  /** `magipilot.chat.discoverModels` (phase-4-models.md M1); the lists are then additions. */
  discoverModels?: boolean;
  /** `magipilot.chat.contextWindowLimit` (phase-4-context.md W4). */
  contextWindowLimit?: number | null;
  /** `magipilot.chat.codex.maxContextWindow` (phase-4-context.md W5). */
  codexMaxContextWindow?: boolean;
  isExcluded(path: string, kind: PathKind): boolean;
}

export interface ChatProviderDeps {
  processes: ProcessRegistry;
  log: Log;
  settings(): ChatSettings;
  isTrusted(): boolean;
  /** Lines and names of excluded workspace files: the content net (phase-2-hardening.md §3). */
  guard?(): Promise<ExcludedContent>;
  /**
   * The names (`matchKey` form) among `names` of id-only attachments to remove: a workspace file
   * with that name is excluded, also through a symlink (phase-2-followup.md, HARD-I013).
   */
  resolveNames?(names: readonly string[]): Promise<ReadonlySet<string>>;
  /** Bumped when the exclusion settings or the workspace folders change (FOLLOWUP-I003). */
  exclusionGeneration?(): number;
  /**
   * A checker, for one request, of whether a string value of a tool call's input names an
   * excluded file (T8); `guard` is that request's index, `commands` the conversation's command
   * lines, whose changes of folder the checker follows (phase-4-hardening.md AC6). Without it,
   * every tool result counts as excluded.
   */
  toolInputChecker?(
    guard: ExcludedContent,
    commands: readonly string[] | undefined,
  ): (value: string, command: boolean) => boolean;
  /** Faz 0 echo models, test mode only (D11). */
  echo?: EchoChatProvider;
  /**
   * Shows a short notice, such as older messages left out for a chosen context size
   * (phase-4-sizes.md S9). The text holds counts and sizes only.
   */
  notify?(text: string): void;
  /** Notices to show once per installation (discovery-only CLIs, P4M-I004). */
  noticeMemory?: { has(key: string): boolean; add(key: string): void };
  /** The models the CLIs report (phase-4-models.md M1, M4, M5); undefined: none found. */
  discovery?: {
    models(cli: CliName, path: string): Promise<readonly DiscoveredModel[] | undefined>;
    invalidate(): void;
  };
  /** Claude's window per model (phase-4-context.md W1, W2); read only while discovery is on. */
  windows?: {
    window(path: string, model: string): number | undefined;
    request(path: string, models: readonly string[]): void;
    /** Drops the queued reads when settings change (inspection P4CTX-I001). */
    invalidate(): void;
  };
}

/** Meta-only record of one request (tests and smoke checks read these; no content). */
export interface ChatRecord {
  modelId: string;
  messages: number;
  promptChars: number;
  /** Prompt lines the content net removed. */
  removedLines: number;
  outputChars: number;
  parts: number;
  ms: number;
  outcome: 'complete' | 'cancelled' | 'error';
  /** Tools the request offered (tool mode only; T12). */
  tools: number;
  /** Tool calls reported back (T12). */
  toolCalls: number;
  /** `Auto` or `Required` when the request offered tools (meta). */
  toolMode?: string;
  /** The context size the user chose for this request; absent for the full size (S5). */
  contextTier?: number;
  /** Messages left out to fit `contextTier` (S3, S5). */
  droppedMessages: number;
  /** The current exchange alone was larger than `contextTier` (S3, D4). */
  overTier?: boolean;
  /**
   * Test only (`MAGIPILOT_CHAT_MARKERS`, comma-separated): whether the answer contained each
   * marker. Only the yes/no result is kept — never the text.
   */
  markers?: Record<string, boolean>;
}

const LABEL: Record<ChatBackendId, string> = {
  'claude-cli': 'Claude CLI',
  'codex-cli': 'Codex CLI',
};

/**
 * Test only (phase-4-sizes.md S7): `MAGIPILOT_TEST_CONTEXT_DEFAULT=<model id>=<tier>`, with
 * `MAGIPILOT_TEST=1`, makes that tier the model's default, since a picker choice cannot be
 * scripted. Anything else leaves the schema as it is.
 */
function withTestTierDefault(
  model: ChatModelDescriptor,
  schema: ModelConfigurationSchema,
): ModelConfigurationSchema {
  const setting =
    process.env.MAGIPILOT_TEST === '1' ? process.env.MAGIPILOT_TEST_CONTEXT_DEFAULT : '';
  const [id, value] = (setting ?? '').split('=');
  const tier = Number(value);
  const context = schema.properties.contextTier;
  if (id !== model.id || !context || !model.contextTiers.includes(tier)) return schema;
  return { properties: { ...schema.properties, contextTier: { ...context, default: tier } } };
}

function roleOf(role: vscode.LanguageModelChatMessageRole): ChatTurn['role'] {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  if (role === vscode.LanguageModelChatMessageRole.User) return 'user';
  // Copilot sends its system prompt with role 3 (System), undeclared in @types/vscode 1.140.
  return 'system';
}

function textOf(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : NON_TEXT_PART))
    .join('');
}

const TEXT_MIME = /^(?:text\/|application\/(?:json|xml)\b)/i;

/** The string `text` fields of a prompt-tsx element tree, in order (best effort). */
function tsxText(value: unknown, out: string[], depth = 0): string[] {
  if (depth > 64 || typeof value !== 'object' || value === null) return out;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'text' && typeof item === 'string') out.push(item);
    else tsxText(item, out, depth + 1);
  }
  return out;
}

/** A tool result's content as text; content that is not text becomes the placeholder (T6). */
function resultText(item: unknown): string {
  if (item instanceof vscode.LanguageModelTextPart) return item.value;
  if (item instanceof vscode.LanguageModelDataPart && TEXT_MIME.test(item.mimeType)) {
    return new TextDecoder().decode(item.data);
  }
  if (item instanceof vscode.LanguageModelPromptTsxPart) {
    const text = tsxText(item.value, []);
    return text.length > 0 ? text.join('') : NON_TEXT_PART;
  }
  return NON_TEXT_PART;
}

/** A request message with its tool parts (phase-4-tools.md T6). */
function requestMessageOf(message: vscode.LanguageModelChatRequestMessage): RequestMessage {
  return {
    role: roleOf(message.role),
    parts: message.content.map((part): MessagePart => {
      if (part instanceof vscode.LanguageModelTextPart) return { kind: 'text', text: part.value };
      if (part instanceof vscode.LanguageModelToolCallPart) {
        return { kind: 'toolCall', callId: part.callId, name: part.name, input: part.input };
      }
      if (part instanceof vscode.LanguageModelToolResultPart) {
        return { kind: 'toolResult', callId: part.callId, texts: part.content.map(resultText) };
      }
      return { kind: 'other' };
    }),
  };
}

/** A call id for a reported tool call; Copilot pairs the result with it. */
function newCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

export class ChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private readonly backends = new Map<string, Backend>();
  private readonly history: ChatRecord[] = [];
  /** Per-model counts for the whole window, not bounded by the history (METRICS-003). */
  readonly stats = new ChatStats();
  private active = 0;
  /**
   * CLI calls started (test only: smoke tests cap them before a call starts, inspection
   * P4T-I003; `MAGIPILOT_TEST_MAX_CLI_CALLS` with `MAGIPILOT_TEST=1`).
   */
  private cliStarts = 0;
  /** Parts reported by the latest request so far (a count only; smoke tests cancel on it). */
  private latestParts = 0;
  /**
   * `<cli> --version` results per executable path. Kept apart from the chat backends: a
   * settings refresh disposes those, and must not abort a running availability probe (which
   * would report the CLI as missing).
   */
  private readonly hiddenNotices = new Set<string>();
  /** Hidden-model reasons already logged (a notice is shown only for a configured list). */
  private readonly loggedHidden = new Set<string>();
  /** Bumped by refresh() (chat settings changed). */
  private settingsGeneration = 0;
  /**
   * Bumped by modelsChanged(): a CLI reported a different list or new windows, so a model's budget
   * may have changed without a settings change (re-inspection P4PICK-I003).
   */
  private modelsGeneration = 0;
  /** Set by dispose(): nothing is asked of a CLI afterwards (inspection P4M-RI002). */
  private disposed = false;
  /**
   * The models of the latest list, by id: a request takes its Codex window argument from here
   * (phase-4-context.md W5). Cleared by refresh(), so a request never uses old settings' value.
   */
  private readonly offered = new Map<string, ChatModelDescriptor>();
  private readonly availability = new Map<
    string,
    { at: number; value?: boolean; pending?: Promise<boolean> }
  >();

  constructor(private readonly deps: ChatProviderDeps) {}

  /** Test only: forgets the latest list without a change event (P4CTX-I003 regression test). */
  forgetOfferedModels(): void {
    this.offered.clear();
  }

  /** Settings or trust changed: rebuild backends and let VS Code re-read the model list (D6). */
  refresh(): void {
    this.settingsGeneration++;
    this.offered.clear();
    this.disposeBackends();
    this.deps.discovery?.invalidate();
    this.deps.windows?.invalidate();
    this.changed.fire();
  }

  /**
   * A CLI reported a different model list or new windows (phase-4-models.md M4,
   * phase-4-context.md W2): VS Code reads it again. When a budget may have shrunk, a request being
   * prepared for the old information is refused (P4PICK-I003); a larger budget is harmless, as
   * the prompt was prepared for the smaller one.
   */
  modelsChanged(mayShrink = true): void {
    if (mayShrink) {
      this.modelsGeneration++;
      this.offered.clear();
    }
    this.changed.fire();
  }

  get records(): readonly ChatRecord[] {
    return this.history;
  }

  /** Requests currently being answered (smoke tests wait on this before cancelling). */
  get inFlight(): number {
    return this.active;
  }

  /** Parts the latest request has streamed so far, 0 when none is running. */
  /** CLI calls started in this window (test API; P4T-I003). */
  get cliCallsStarted(): number {
    return this.cliStarts;
  }

  get partsInFlight(): number {
    return this.active > 0 ? this.latestParts : 0;
  }

  /**
   * One backend per model, effort and Codex window, so `Backend` stays unchanged
   * (phase-4-effort.md D4, phase-4-context.md W5).
   */
  private backendFor(
    backend: ChatBackendId,
    model: string,
    effort?: Effort,
    contextWindow?: number,
  ): Backend {
    const key = `${backend}.${model}.${effort ?? ''}.${contextWindow ?? ''}`;
    const existing = this.backends.get(key);
    if (existing) return existing;
    const settings = this.deps.settings();
    const created =
      backend === 'claude-cli'
        ? new ClaudeCliBackend({
            path: settings.claudePath,
            model,
            warmPoolSize: 0,
            disableNonessentialTraffic: settings.disableNonessentialTraffic,
            timeoutMs: CHAT_TIMEOUT_MS,
            processes: this.deps.processes,
            ...(effort ? { effort } : {}),
          })
        : new CodexCliBackend({
            path: settings.codexPath,
            model,
            effort: effort ?? settings.codexEffort,
            timeoutMs: CHAT_TIMEOUT_MS,
            processes: this.deps.processes,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
          });
    this.backends.set(key, created);
    return created;
  }

  /** Keys of the hidden-model notices shown in this session (meta; tests read them). */
  get hiddenModelNotices(): readonly string[] {
    return [...this.hiddenNotices];
  }

  /**
   * Configured models of a CLI that the picker cannot show are reported once per session, with
   * the reason and what to check (phase-3-errors AC5); before, they disappeared without notice.
   */
  private noticeHidden(
    cli: CliName,
    inPlay: boolean,
    configured: boolean,
    shown: boolean,
    trusted: boolean,
  ): void {
    if (!inPlay || shown) return;
    const reason = !trusted
      ? 'untrusted'
      : process.platform === 'win32'
        ? 'windows'
        : 'not-installed';
    // Untrusted and Windows hide both CLIs: one notice covers them.
    const key = reason === 'not-installed' ? `${cli}:not-installed` : reason;
    if (!this.loggedHidden.has(key)) {
      this.loggedHidden.add(key);
      this.deps.log.warn('chat models hidden', { cli, reason });
    }
    // Only discovery put this CLI in play (no configured model): the notice is shown once per
    // installation, not at every start, so a user without that CLI is told but not nagged
    // (inspection P4M-I004).
    if (!configured) {
      const remembered = `discovery:${key}`;
      if (this.deps.noticeMemory?.has(remembered)) return;
      this.deps.noticeMemory?.add(remembered);
    }
    if (this.hiddenNotices.has(key)) return;
    this.hiddenNotices.add(key);
    if (reason === 'not-installed') {
      const label = cli === 'claude' ? 'Claude (CLI)' : 'Codex (CLI)';
      void vscode.window
        .showWarningMessage(
          `Magipilot: ${failureMessage(cli, 'not-installed')} The ${label} models are hidden from the model picker until then.`,
          'Open Settings',
        )
        .then((choice) => {
          if (choice === 'Open Settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              `magipilot.${cli}.path`,
            );
          }
        });
      return;
    }
    void vscode.window.showWarningMessage(
      reason === 'untrusted'
        ? 'Magipilot: the Claude (CLI) and Codex (CLI) models are hidden in untrusted workspaces. Trust the workspace to use them.'
        : 'Magipilot: the Claude (CLI) and Codex (CLI) models are not available on Windows.',
    );
  }

  private isAvailable(path: string): Promise<boolean> {
    const cached = this.availability.get(path);
    if (cached?.pending) return cached.pending;
    if (cached?.value !== undefined && Date.now() - cached.at < AVAILABILITY_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    const pending = probeExecutable(this.deps.processes, path)
      .catch(() => false)
      .then((value) => {
        this.availability.set(path, { at: Date.now(), value });
        return value;
      });
    this.availability.set(path, { at: Date.now(), pending });
    return pending;
  }

  /** The CLI models currently offered (also used by the commit-message command). */
  async currentModels(): Promise<ChatModelDescriptor[]> {
    // Settings that change while the CLIs are asked make the answer stale: it is computed again
    // from the new settings, so a CLI is never asked under settings that no longer hold
    // (inspection P4M-I002). Three tries; settings rarely change that fast.
    for (let attempt = 0; attempt < 3 && !this.disposed; attempt++) {
      const result = await this.modelsFor(this.settingsGeneration);
      if (result !== undefined) return result;
    }
    // Still changing: none for now; the change itself makes VS Code ask again.
    return [];
  }

  /** The models under the settings of `generation`; undefined when they changed meanwhile. */
  private async modelsFor(generation: number): Promise<ChatModelDescriptor[] | undefined> {
    const settings = this.deps.settings();
    const trusted = this.deps.isTrusted();
    const gatesOpen = trusted && process.platform !== 'win32';
    // A CLI is in play when discovery is on or its list is not empty (phase-4-models.md M5): then
    // it is probed, and a missing CLI raises the hidden-model notice.
    const discovery = settings.discoverModels === true ? this.deps.discovery : undefined;
    const claudeInPlay = discovery !== undefined || settings.claudeModels.length > 0;
    const codexInPlay = discovery !== undefined || settings.codexModels.length > 0;
    const available = async (path: string, inPlay: boolean): Promise<boolean> =>
      gatesOpen && inPlay && (await this.isAvailable(path));
    const [claudeAvailable, codexAvailable] = await Promise.all([
      available(settings.claudePath, claudeInPlay),
      available(settings.codexPath, codexInPlay),
    ]);
    // Settings changed while the probes ran: this snapshot is stale and must not report hidden
    // models (inspection P3E-I004) or start discovery under the old settings (P4M-I002). After
    // dispose() nothing more is started (P4M-RI002).
    if (this.disposed) return [];
    if (generation !== this.settingsGeneration) return undefined;
    this.noticeHidden(
      'claude',
      claudeInPlay,
      settings.claudeModels.length > 0,
      claudeAvailable,
      trusted,
    );
    this.noticeHidden(
      'codex',
      codexInPlay,
      settings.codexModels.length > 0,
      codexAvailable,
      trusted,
    );
    // The discovered models, then the configured ids they lack; on a failure, the last good
    // list, else the configured list alone (M5).
    const [claudeFound, codexFound] = await Promise.all([
      discovery && claudeAvailable ? discovery.models('claude', settings.claudePath) : undefined,
      discovery && codexAvailable ? discovery.models('codex', settings.codexPath) : undefined,
    ]);
    if (this.disposed) return [];
    if (generation !== this.settingsGeneration) return undefined;
    let claudeModels = mergeModels(claudeFound ?? [], settings.claudeModels);
    // Claude's windows (phase-4-context.md W1, W2): known ones at once; the missing and stale ones
    // are read in the background, and their arrival makes VS Code ask again. Only while
    // discovery is on, as asking the CLI is discovery.
    const windows = discovery && claudeAvailable ? this.deps.windows : undefined;
    if (windows) {
      windows.request(
        settings.claudePath,
        claudeModels.map((model) => model.id),
      );
      claudeModels = claudeModels.map((model) => {
        const window = windows.window(settings.claudePath, model.id);
        return window !== undefined ? { ...model, contextWindow: window } : model;
      });
    }
    const models = chatModels(
      {
        claudeModels,
        codexModels: mergeModels(codexFound ?? [], settings.codexModels),
        windowLimit: settings.contextWindowLimit,
        codexMaxWindow: settings.codexMaxContextWindow,
      },
      { trusted, platform: process.platform, claudeAvailable, codexAvailable },
    );
    this.offered.clear();
    for (const model of models) this.offered.set(model.id, model);
    return models;
  }

  /**
   * The provider VS Code registers for one vendor (phase-4-context.md G1): only that CLI's models,
   * the echo models with Claude's (test mode). Requests, token counts, the change event and the
   * backends are this provider's own.
   */
  forVendor(backend: ChatBackendId): vscode.LanguageModelChatProvider {
    return {
      onDidChangeLanguageModelChatInformation: this.changed.event,
      provideLanguageModelChatInformation: (options, token) =>
        this.information(options, token, backend),
      provideLanguageModelChatResponse: (model, messages, options, progress, token) => {
        // VS Code routes by vendor; a model of the other CLI is refused, not answered.
        const parsed = parseChatModelId(model.id);
        if (parsed && parsed.backend !== backend) {
          return Promise.reject(new Error('Magipilot: unknown model'));
        }
        return this.provideLanguageModelChatResponse(model, messages, options, progress, token);
      },
      provideTokenCount: (model, text) => this.provideTokenCount(model, text),
    };
  }

  provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return this.information(options, token);
  }

  /** Every model, or one CLI's (`only`) with the echo models beside Claude's. */
  private async information(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
    only?: ChatBackendId,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const echo =
      only === undefined || only === 'claude-cli'
        ? (this.deps.echo?.provideLanguageModelChatInformation() ?? [])
        : [];
    const models = (await this.currentModels()).filter(
      (model) => only === undefined || model.backend === only,
    );
    if (token.isCancellationRequested) return echo;
    // Off by default (T1); with it, Copilot also offers the models in agent mode and inline chat,
    // for the CLIs whose models call tools (measured; `supportsToolCalling`).
    const toolCalling = this.deps.settings().toolCalling;
    return [
      ...echo,
      ...models.map((model) => ({
        id: model.id,
        name: model.name,
        family: model.family,
        version: '1',
        detail: model.detail,
        tooltip: model.tooltip,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        // Not in the stable API; VS Code 1.144 reads both from any provider (phase-4-effort.md
        // D1): the context size it shows, and the picker's "Thinking effort" submenu.
        maxContextWindowTokens: model.maxContextWindowTokens,
        ...(model.configurationSchema
          ? { configurationSchema: withTestTierDefault(model, model.configurationSchema) }
          : {}),
        capabilities: {
          toolCalling: toolCalling && supportsToolCalling(model.family),
          imageInput: false,
        },
      })),
    ];
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (model.id.startsWith(ECHO_PREFIX) && this.deps.echo) {
      return this.deps.echo.provideLanguageModelChatResponse(
        model,
        messages,
        options,
        progress,
        token,
      );
    }
    const parsed = parseChatModelId(model.id);
    if (!parsed) throw new Error(`Magipilot: unknown model`);
    if (!this.deps.isTrusted() || process.platform === 'win32') {
      throw new Error('Magipilot: CLI models are disabled in untrusted workspaces and on Windows');
    }
    // One settings generation for the whole request (inspection P4PICK-I001): these settings, the
    // model resolved below and the backend started at the end all belong to it; a change while the
    // request is prepared refuses it before any CLI starts.
    const generation = this.settingsGeneration;
    const modelsGeneration = this.modelsGeneration;
    const settings = this.deps.settings();
    // The model as these settings offer it (inspection P4CTX-I002): Codex's window argument (W5)
    // and the size gate's budget (W3) come from this one descriptor. It is resolved before the
    // exclusion read below, so no await separates the last exclusion check from dispatch
    // (re-inspection P4CTX-I003). An emptied list (settings changed before this request) is
    // computed again, never assumed.
    const current =
      this.offered.get(model.id) ??
      (await this.currentModels()).find((offered) => offered.id === model.id);
    if (!current) throw new Error('Magipilot: unknown model');
    // Trimmed by Copilot Chat for a larger budget than the model has now (the limit was lowered,
    // or Codex's largest window turned off, and VS Code has not read the models again): it may
    // not fit, so it is not sent.
    if (typeof model.maxInputTokens === 'number' && model.maxInputTokens > current.maxInputTokens) {
      this.deps.log.warn('chat window changed', {
        backend: parsed.backend,
        prepared: model.maxInputTokens,
        now: current.maxInputTokens,
      });
      throw new Error(
        "Magipilot: the model's context size changed while the request was prepared; send the message again",
      );
    }
    // Tool calling off: exactly the Faz 3 conversion, tool parts as the placeholder (AC1). On:
    // tool parts are rendered between per-request boundaries, and the result of a call whose input
    // names an excluded file is dropped as a whole (T6, T8).
    const toolCalling = settings.toolCalling && supportsToolCalling(parsed.backend);
    const toolNonce = toolCalling ? newToolNonce() : undefined;
    const tools = toolCalling ? (options.tools ?? []) : [];
    const requestMessages = toolNonce !== undefined ? messages.map(requestMessageOf) : undefined;
    // Before the index is read, every tool result is kept: these texts only feed the lookup of
    // id-only attachment names below. The prompt's turns are built after it (T8 needs the index).
    const firstTurns: ChatTurn[] =
      requestMessages && toolNonce !== undefined
        ? toolTurns(requestMessages, toolNonce, () => false)
        : messages.map((message) => ({ role: roleOf(message.role), text: textOf(message) }));
    // Id-only attachments (a binary file's hex dump) name their file only by its basename; names
    // the index does not hold are looked up now, and a failed lookup removes them (HARD-I013).
    // The index and the lookup must belong to the same exclusion settings (FOLLOWUP-I003).
    const matchOptions = platformExcludeOptions();
    const texts = firstTurns.map((turn) => turn.text);
    const resolveNames = this.deps.resolveNames?.bind(this.deps);
    const resolvedAt = Date.now();
    const read = await readStable(
      () => this.deps.exclusionGeneration?.() ?? 0,
      async () => {
        let guard: ExcludedContent | undefined;
        try {
          guard = await this.deps.guard?.();
        } catch {
          // The parser still applies; only the net is missing for this request.
          this.deps.log.warn('exclude index failed');
        }
        const resolved = resolveNames
          ? await idOnlyNamesForRequest(texts, guard?.names, resolveNames, matchOptions)
          : undefined;
        return { guard, resolved };
      },
    );
    const { guard, resolved } = read.value;
    let idOnlyNames = resolved?.names;
    if (!read.stable) {
      // The settings kept changing while the request read them: every id-only attachment goes.
      this.deps.log.warn('exclusion settings kept changing');
      if (resolveNames) idOnlyNames = allIdOnlyNames(texts, matchOptions);
    }
    if (resolved && resolved.asked > 0) {
      this.deps.log.info('id-only names', {
        asked: resolved.asked,
        excluded: idOnlyNames?.size ?? 0,
        failed: resolved.failed,
        stable: read.stable,
        ms: Date.now() - resolvedAt,
      });
    }
    // The result of a call whose input names an excluded file is dropped as a whole (T8); the
    // checker also matches wildcards against the excluded files the index found. Without a
    // checker every tool result counts as excluded: also when the index failed or the exclusion
    // settings kept changing, since then neither the content net nor the checker's wildcard,
    // folder and tail rules can work (phase-4-hardening.md AC5, plan review P4H-001).
    // Each string of an earlier call input gets the turn filters (evidence, diffs, content net)
    // before it is serialized, and each result the content net with search tools' prefixes too
    // (inspection P4T-I001, re-inspection P4T-RI001; the result side is primary).
    let turns = firstTurns;
    if (requestMessages && toolNonce !== undefined) {
      const commands = commandValues(
        requestMessages.flatMap((message) =>
          message.parts.flatMap((part) => (part.kind === 'toolCall' ? [part] : [])),
        ),
      );
      const checker =
        guard !== undefined && read.stable
          ? this.deps.toolInputChecker?.(guard, commands)
          : undefined;
      turns = toolTurns(
        requestMessages,
        toolNonce,
        (input, toolName) =>
          checker === undefined ||
          inputExcluded(input, (value, key) => checker(value, isCommandValue(toolName, key))),
        {
          // Without the index (it failed), the evidence and diff filters still apply to inputs.
          input: (text) =>
            filterTurnText(
              text,
              'assistant',
              (path, kind) => settings.isExcluded(path, kind),
              guard,
              { idOnlyNames, caseInsensitive: matchOptions.caseInsensitive },
            ).text,
          result: guard
            ? (text) => redactExcludedLines(text, guard, { searchPrefixes: true }).text
            : undefined,
        },
      );
    }
    const required = options.toolMode === vscode.LanguageModelChatToolMode.Required;
    const promptOptions: CliPromptOptions = {
      idOnlyNames,
      caseInsensitive: matchOptions.caseInsensitive,
      toolNonce,
      tools:
        tools.length > 0
          ? {
              specs: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              })),
              required,
            }
          : undefined,
    };
    // Every turn is filtered once; then, with a context size the user chose, the oldest exchanges
    // are left out until the conversation fits (phase-4-sizes.md S2, S3). Synchronous: no await
    // separates the exclusion read from dispatch (P4CTX-I003).
    const filtered = filterTurns(
      turns,
      (path, kind) => settings.isExcluded(path, kind),
      guard,
      promptOptions,
    );
    const configuration = (options as { modelConfiguration?: Record<string, unknown> })
      .modelConfiguration;
    const tier = chosenTier(current.contextTiers, configuration?.contextTier);
    const trim =
      tier !== undefined
        ? trimToTier(
            filtered.turns,
            exchangeStarts(
              filtered.turns,
              messages.map((message) =>
                message.content.some((part) => part instanceof vscode.LanguageModelToolResultPart),
              ),
            ),
            tier,
          )
        : undefined;
    const kept = trim ? filtered.turns.filter((_, i) => trim.keep[i]) : filtered.turns;
    const removedLines = filtered.removed.reduce(
      (sum, removed, i) => (trim && !trim.keep[i] ? sum : sum + removed),
      0,
    );
    const { system, prompt } = assembleCliPrompt(kept, promptOptions);
    // The picker's effort (E2), checked against the levels this model offers: VS Code passes the
    // model information it got from currentModels() back, schema included.
    const effort = effortFor(
      (model as { configurationSchema?: ModelConfigurationSchema }).configurationSchema,
      configuration?.reasoningEffort,
    ) as Effort | undefined;
    // No await lies between this check and the backend's start.
    if (generation !== this.settingsGeneration) {
      this.deps.log.warn('chat settings changed', { backend: parsed.backend });
      throw new Error(
        'Magipilot: the chat settings changed while the request was prepared; send the message again',
      );
    }
    // A CLI's models or windows changed meanwhile: the budget may have shrunk (P4PICK-I003).
    if (modelsGeneration !== this.modelsGeneration) {
      this.deps.log.warn('chat models changed', { backend: parsed.backend });
      throw new Error(
        "Magipilot: the model's information changed while the request was prepared; send the message again",
      );
    }
    if (tier !== undefined && trim && (trim.dropped > 0 || trim.overTier)) {
      const meta = {
        backend: parsed.backend,
        contextTier: tier,
        dropped: trim.dropped,
        overTier: trim.overTier,
      };
      this.deps.log.info('chat history trimmed', meta);
      this.deps.notify?.(trimNotice(trim.dropped, trim.overTier, tier));
    }
    const backend = this.backendFor(parsed.backend, parsed.model, effort, current.cliContextWindow);
    const label = LABEL[parsed.backend];

    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    const startedAt = Date.now();
    let outputChars = 0;
    let parts = 0;
    let toolCalls = 0;
    const markers = (process.env.MAGIPILOT_CHAT_MARKERS ?? '').split(',').filter(Boolean);
    let output = markers.length > 0 ? '' : undefined;
    const finish = (outcome: ChatRecord['outcome']): void => {
      const record: ChatRecord = {
        modelId: model.id,
        messages: messages.length,
        promptChars: prompt.length,
        removedLines,
        outputChars,
        parts,
        ms: Date.now() - startedAt,
        outcome,
        tools: tools.length,
        toolCalls,
        ...(tools.length > 0 ? { toolMode: required ? 'Required' : 'Auto' } : {}),
        ...(tier !== undefined ? { contextTier: tier } : {}),
        droppedMessages: trim?.dropped ?? 0,
        ...(trim?.overTier ? { overTier: true } : {}),
        ...(output !== undefined
          ? { markers: Object.fromEntries(markers.map((m) => [m, output!.includes(m)])) }
          : {}),
      };
      output = undefined;
      this.history.push(record);
      if (this.history.length > 200) this.history.shift();
      this.stats.record(record.modelId, outcome, record.ms);
      const { markers: _markers, ...meta } = record;
      this.deps.log.info('chat', meta);
    };
    if (tools.length > 0) {
      // Context accounting (T13b): a prompt that cannot fit fails before any CLI call.
      // Only a prompt that certainly cannot fit is refused (a lower bound; smoke:agent showed
      // that the byte upper bound refuses every agent-mode request).
      const estimate = minimumTokens({ system, prompt });
      // The requested model's own budget under the current settings (W3, P4CTX-I002).
      const budget = requestBudget(parsed.backend, current.maxInputTokens);
      if (estimate > budget) {
        finish('error');
        this.deps.log.warn('chat prompt too large', { backend: parsed.backend, estimate, budget });
        throw new Error(
          'Magipilot: the conversation and its tools are too large for this model; start a new chat or turn off some tools',
        );
      }
    }
    this.active++;
    this.latestParts = 0;
    try {
      if (token.isCancellationRequested) {
        finish('cancelled');
        return;
      }
      const budget =
        process.env.MAGIPILOT_TEST === '1'
          ? Number(process.env.MAGIPILOT_TEST_MAX_CLI_CALLS ?? Number.NaN)
          : Number.NaN;
      if (Number.isFinite(budget) && this.cliStarts >= budget) {
        throw new Error('the test call budget is spent');
      }
      this.cliStarts++;
      if (tools.length > 0) {
        // Tool mode (T2–T4, T7): one structured answer; the provider only reports the calls, and
        // Copilot Chat runs them (rules 2, 3).
        if (!isStructuredChatBackend(backend)) throw new Error('tool calling is not supported');
        const answer = await backend.runStructured(prompt, { system, signal: controller.signal });
        if (token.isCancellationRequested) {
          finish('cancelled');
          return;
        }
        const calls = validateToolCalls(answer, new Set(tools.map((tool) => tool.name)), required);
        if (answer.message.trim() !== '') {
          outputChars += answer.message.length;
          parts++;
          if (output !== undefined) output += answer.message;
          progress.report(new vscode.LanguageModelTextPart(answer.message));
        }
        for (const call of calls) {
          parts++;
          toolCalls++;
          progress.report(new vscode.LanguageModelToolCallPart(newCallId(), call.name, call.input));
        }
        this.latestParts = parts;
        finish('complete');
        return;
      }
      for await (const chunk of backend.run(prompt, { system, signal: controller.signal })) {
        if (token.isCancellationRequested) break;
        outputChars += chunk.length;
        parts++;
        this.latestParts = parts;
        if (output !== undefined) output += chunk;
        progress.report(new vscode.LanguageModelTextPart(chunk));
      }
      finish(token.isCancellationRequested ? 'cancelled' : 'complete');
    } catch (err) {
      if (token.isCancellationRequested || isAbort(err)) {
        finish('cancelled');
        return;
      }
      finish('error');
      if (err instanceof InvalidAnswerError) {
        this.deps.log.warn('chat answer invalid', { backend: parsed.backend, reason: err.reason });
        throw new Error(
          `Magipilot: ${label} returned an unusable tool-call answer: ${err.message}`,
          {
            cause: err,
          },
        );
      }
      // A classified CLI failure carries a fixed, actionable message (phase-3-errors §4).
      if (isCliFailure(err)) {
        this.deps.log.warn('chat failed', {
          backend: parsed.backend,
          failure: err.kind,
          detail: err.detail,
        });
        throw new Error(`Magipilot: ${err.message}`, { cause: err });
      }
      // Backend messages are content-free (Faz 1 C6); they are safe to show.
      const reason = err instanceof Error ? err.message : 'request failed';
      throw new Error(`Magipilot: ${reason.startsWith(label) ? reason : `${label} ${reason}`}`, {
        cause: err,
      });
    } finally {
      this.active--;
      subscription.dispose();
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    // Tool calls and results count in full, as the transcript renders them (T13a): an upper bound.
    return Promise.resolve(
      typeof text === 'string'
        ? estimateTokens(text)
        : estimateTokens(renderMessage(requestMessageOf(text), COUNTING_NONCE), 1),
    );
  }

  private disposeBackends(): void {
    for (const backend of this.backends.values()) backend.dispose();
    this.backends.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeBackends();
    this.changed.dispose();
  }
}
