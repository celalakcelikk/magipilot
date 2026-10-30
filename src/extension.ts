import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import * as vscode from 'vscode';
import {
  BackendRegistry,
  type BackendSettings,
  type OpenAiCompatMode,
} from './core/backends/registry';
import type { Backend, BackendId } from './core/backends/types';
import { CompletionCache } from './core/cache';
import type { Effort } from './core/process/cliArgs';
import type { FimFamily } from './core/prompt/fimTemplates';
import { ProcessRegistry } from './core/process/runner';
import {
  COMMIT_ROUTING_COMMAND,
  migrateUtilityModels,
  useForCommitMessages,
} from './features/chat/commitRouting';
import { resolveExcludedNames, type ExcludedContent } from './features/chat/contentGuard';
import { ExcludedContentIndex } from './features/chat/excludedIndex';
import type { PathKind } from './features/chat/messages';
import { ChatProvider, type ChatRecord, type ChatSettings } from './features/chat/provider';
import { commandFolders, toolInputChecker } from './features/chat/toolInput';
import { ModelDiscovery, type DiscoveredModel } from './features/chat/modelDiscovery';
import {
  probeClaudeModels,
  probeClaudeWindow,
  probeCodexModels,
} from './features/chat/modelProbes';
import { ClaudeWindows } from './features/chat/modelWindows';
import { assumedWindow, vendorOf } from './features/chat/models';
import { ACCEPT_COMMAND, InlineProvider } from './features/inline/provider';
import { isExcluded, matchKey, platformExcludeOptions } from './core/context/exclude';
import type { InlineSettings } from './features/inline/rules';
import { Metrics } from './metrics';
import { EchoChatProvider, type EchoRequestSize } from './spike/echoProvider';
import { ProbeLog } from './spike/probeLog';
import { DEFAULT_IMPORT_OPTIONS, ImportContext } from './core/context/importContext';
import { NodeImportFs } from './features/inline/importFs';
import { Log } from './ui/log';
import { StatsPanel } from './ui/statsPanel';
import { StatusBar, type InlineState } from './ui/statusBar';

/** Per-request limit for CLI inline completions. */
const CLI_TIMEOUT_MS = 30_000;
const TOGGLE_COMMAND = 'magipilot.toggleInline';

/** Returned by activate() only when MAGIPILOT_TEST=1 (integration tests, docs/plans/phase-1.md §4.5). */
export interface TestApi {
  setBackendOverride(backend: Backend | undefined): void;
  provider: InlineProvider;
  metrics: Metrics;
  /** The host-death guard (D13); started with the first CLI process. */
  watchdogPid(): number | undefined;
  statusState(): InlineState;
  /** Meta-only records of chat requests (no content). */
  chatRecords(): readonly ChatRecord[];
  chatInFlight(): number;
  /** Parts the running chat request has streamed so far (a count, no content). */
  chatPartsInFlight(): number;
  /** Drops the content-net index so the next chat request rebuilds it (tests create files). */
  invalidateExcludedIndex(): void;
  /** Keys of the hidden-model notices shown in this session (phase-3-errors AC5). */
  chatHiddenNotices(): readonly string[];
  /** HTML of the open `Show Stats` panel, or undefined while it is closed. */
  statsHtml(): string | undefined;
  /** The chat models as the provider declares them (capabilities included; phase-4-tools AC1). */
  chatModelInfo(): Promise<vscode.LanguageModelChatInformation[]>;
  /** Sizes of the requests the echo models received (phase-4-tools T10a; meta only). */
  echoRequestSizes(): readonly EchoRequestSize[];
  /** CLI calls the chat provider started (phase-4-tools inspection P4T-I003). */
  chatCliCallsStarted(): number;
  /**
   * Import signatures' timing (phase-3-context P5): each file-system operation waits `delayMs`;
   * the deadlines default to the production values.
   */
  setImportTiming(timing: {
    delayMs: number;
    deadlineMs?: number;
    dependencyCheckMs?: number;
  }): void;
  /**
   * Exclusion faults for the next chat requests (phase-4-hardening.md AC5): the content-net index
   * fails, or the exclusion settings change on every read. `holdMs` delays the index read, so a
   * test can change settings while a request is prepared; `refreshAfterIndex` changes them right
   * after it (inspection P4CTX-I002); `holdModelsMs` delays model discovery, which a request may
   * wait for (re-inspection P4CTX-I003).
   */
  setExclusionFaults(faults: {
    indexFails?: boolean;
    unstable?: boolean;
    holdMs?: number;
    refreshAfterIndex?: boolean;
    holdModelsMs?: number;
  }): void;
  /** Forgets the provider's latest model list without a change event (P4CTX-I003 test). */
  forgetChatModels(): void;
  /** Reports changed model information, as discovery or a window read does (P4PICK-I003 test). */
  notifyModelsChanged(): void;
  /** Forgets the discovered model lists, stored ones too (phase-4-models.md tests). */
  clearDiscoveredModels(): Promise<void>;
  /** The latest model-discovery events: CLI, count or failure kind, duration (meta only). */
  discoveryEvents(): readonly object[];
  /** The notices remembered as shown once per installation (P4M-I004). */
  discoveryNotices(): readonly string[];
  /**
   * Forgets Claude's context windows, stored ones too, after the running reads end
   * (phase-4-context.md tests).
   */
  clearWindows(): Promise<void>;
  /** The latest window-read batches: models asked, windows, failures, duration (meta only). */
  windowEvents(): readonly object[];
  /** Runs the utility-setting migration of phase-4-context.md G2 again (tests). */
  migrateUtilityModels(): Promise<{ rewritten: string[]; reported: string[] }>;
  /**
   * Sends one request to a Magipilot model with a picker configuration, as VS Code does after a
   * "Thinking effort" choice (phase-4-effort.md E2, inspection P4E-I001); returns the text parts.
   */
  chatRequestWithConfiguration(
    modelId: string,
    configuration: Record<string, unknown>,
    text: string,
    tools?: readonly vscode.LanguageModelChatTool[],
    /** Replaces fields of the model information, as a stale copy in VS Code would (P4CTX-I002). */
    info?: { maxInputTokens?: number },
  ): Promise<string[]>;
  /**
   * Sends a whole conversation to a Magipilot model with a picker configuration, as Copilot Chat
   * does (phase-4-sizes.md P3); returns the text parts.
   */
  chatConversation(
    modelId: string,
    configuration: Record<string, unknown> | undefined,
    turns: readonly ConversationTurn[],
    tools?: readonly vscode.LanguageModelChatTool[],
  ): Promise<string[]>;
  /** The last notice about messages left out for a chosen context size (phase-4-sizes.md S9). */
  lastChatNotice(): string | undefined;
}

/** A turn for `TestApi.chatConversation`: text, or a tool call or its result (tests only). */
export type ConversationTurn =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'assistant'; toolCall: { callId: string; name: string; input: object } }
  | { role: 'user'; toolResult: { callId: string; text: string } };

/** The VS Code message for a test turn. */
function conversationMessage(turn: ConversationTurn): vscode.LanguageModelChatMessage {
  if ('toolCall' in turn) {
    const { callId, name, input } = turn.toolCall;
    return vscode.LanguageModelChatMessage.Assistant([
      new vscode.LanguageModelToolCallPart(callId, name, input),
    ]);
  }
  if ('toolResult' in turn) {
    return vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart(turn.toolResult.callId, [
        new vscode.LanguageModelTextPart(turn.toolResult.text),
      ]),
    ]);
  }
  return turn.role === 'user'
    ? vscode.LanguageModelChatMessage.User(turn.text)
    : vscode.LanguageModelChatMessage.Assistant(turn.text);
}

let processes: ProcessRegistry | undefined;
let backends: BackendRegistry | undefined;
let chat: ChatProvider | undefined;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('magipilot');
}

function inlineSettings(): InlineSettings {
  const c = config();
  return {
    enabled: c.get('inline.enabled', true),
    mode: c.get<'auto' | 'manual'>('inline.mode', 'auto'),
    debounceMs: c.get<number | null>('inline.debounceMs', null),
    maxPrefixChars: c.get('inline.maxPrefixChars', 3000),
    maxSuffixChars: c.get('inline.maxSuffixChars', 1000),
    maxLines: c.get('inline.maxLines', 8),
    maxFileSizeKb: c.get('inline.maxFileSizeKb', 1024),
    importSignatures: c.get('inline.importSignatures', true),
    exclude: excludePatterns(),
    disabledLanguages: c.get<string[]>('disabledLanguages', ['plaintext', 'markdown']),
  };
}

function backendSettings(): BackendSettings {
  const c = config();
  return {
    inlineBackend: c.get<BackendId>('inline.backend', 'ollama'),
    fallbackBackend: c.get<BackendId | 'none'>('inline.fallbackBackend', 'none'),
    claude: {
      path: c.get('claude.path', 'claude') || 'claude',
      inlineModel: c.get('claude.inlineModel', 'haiku'),
      effort: c.get<Effort>('claude.effort', 'low'),
      warmPoolSize: Math.max(0, c.get('claude.warmPoolSize', 1)),
      disableNonessentialTraffic: c.get('claude.disableNonessentialTraffic', true),
    },
    codex: {
      path: c.get('codex.path', 'codex') || 'codex',
      inlineModel: c.get('codex.inlineModel', 'gpt-6-luna'),
      effort: c.get<Effort>('codex.effort', 'low'),
    },
    cliTimeoutMs: CLI_TIMEOUT_MS,
    ollama: {
      url: c.get('ollama.url', 'http://localhost:11434'),
      model: c.get('ollama.model', 'qwen2.5-coder:1.5b'),
      fim: c.get<'suffix' | 'raw'>('ollama.fim', 'suffix'),
      template: c.get<FimFamily>('ollama.template', 'qwen'),
    },
    openaiCompat: {
      url: c.get('openaiCompat.url', 'http://localhost:8080'),
      model: c.get('openaiCompat.model', ''),
      fimTemplate: c.get<OpenAiCompatMode>('openaiCompat.fimTemplate', 'server'),
    },
    custom: {
      template: c.get('openaiCompat.customTemplate', ''),
      stop: c.get<string[]>('openaiCompat.customStop', []),
    },
  };
}

interface GitApi {
  repositories: readonly { rootUri: vscode.Uri }[];
}

/** Roots of the Git repositories VS Code's Git extension knows (none when it is not active). */
function gitRepositoryRoots(): vscode.Uri[] {
  const git = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!git?.isActive) return [];
  try {
    return git.exports.getAPI(1).repositories.map((repository) => repository.rootUri);
  } catch {
    return [];
  }
}

/**
 * The path `magipilot.exclude` patterns are matched against: workspace-relative inside a
 * workspace folder, else absolute (phase-2.md D4, as the inline provider does). Matching the
 * absolute path of a workspace file too would also match the folders above the workspace, which
 * the content net's discovery cannot search (inspection HARD-I002, red-team case over-r1-8).
 */
function excludeMatchPath(path: string): string {
  const relative = vscode.workspace.asRelativePath(vscode.Uri.file(path), false);
  if (!isAbsolute(relative)) return relative;
  // A realpath of a workspace file (H8d) when the folder itself is reached through a symlink
  // (on macOS /var and /tmp are links to /private/...): relative to the folder's realpath.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const real = realpathSync(folder.uri.fsPath);
      if (path.startsWith(real + sep)) return path.slice(real.length + 1);
    } catch {
      // A folder that is gone: no realpath to compare with.
    }
  }
  return relative;
}

function excludePatterns(): string[] {
  return config().get<string[]>('exclude', ['.env*', '*.pem', 'secrets/**']);
}

/**
 * A chat path against `magipilot.exclude` (phase-2.md D4, phase-2-hardening.md H8). The filter
 * has already decoded `file:` URIs; `kind` says whether the path came from a diff header.
 */
function isExcludedPath(path: string, kind: PathKind): boolean {
  const patterns = excludePatterns();
  const options = platformExcludeOptions();
  const matches = (candidate: string): boolean =>
    isExcluded(excludeMatchPath(candidate), patterns, options);
  if (matches(path)) return true;
  if (isAbsolute(path)) {
    // A path cut short by an odd file name (a quote, `>` or a line break in it) names no real
    // file; such metadata cannot be trusted, so it counts as excluded (inspection P2-I011). An
    // element's path attribute is not file metadata (`<Route path="/dashboard">`): patterns only.
    if (!existsSync(path)) return kind !== 'element';
    // A symlinked alias of an excluded file (H8d).
    try {
      const real = realpathSync(path);
      return real !== path && matches(real);
    } catch {
      return true;
    }
  }
  // Diff paths are relative to their repository, which may sit below the workspace root
  // (inspection P2-I009). Attachment ids are not, so they are not joined (H8e, red-team case 04).
  if (kind !== 'diff') return false;
  // Every repository counts, so a repository inside an excluded folder also excludes the diffs of
  // the others with the same relative path (case 04, a documented cost). Dropping a repository
  // because the path is missing from its disk or from the Git extension's cached state would let
  // the removed lines of a file deleted there through (security review of `ff6bdfc`).
  return gitRepositoryRoots().some((root) => matches(vscode.Uri.joinPath(root, path).fsPath));
}

/**
 * The names (`matchKey` form) of id-only attachments to remove: a workspace file with that name
 * is excluded, also through a symlink with another name, since `isExcludedPath` tests the
 * realpath (phase-2-followup.md, HARD-I013). Failures and caps count as excluded.
 */
function resolveAttachmentNames(names: readonly string[], log: Log): Promise<ReadonlySet<string>> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const options = platformExcludeOptions();
  // findFiles follows symlinks only with search.followSymlinks; with it off an alias with
  // another name is not found, so every name counts as excluded (FOLLOWUP-I005).
  const followsSymlinks = folders.every(
    (folder) =>
      vscode.workspace.getConfiguration('search', folder.uri).get<boolean>('followSymlinks') !==
      false,
  );
  if (!followsSymlinks) {
    log.warn('binary attachments removed: search.followSymlinks is off', { names: names.length });
    return Promise.resolve(new Set(names.map((name) => matchKey(name, options))));
  }
  return resolveExcludedNames(
    names,
    async (glob, max) => {
      const paths: string[] = [];
      let cut = false;
      for (const folder of folders) {
        // `null`: files.exclude must not hide a file from the lookup (HARD-R002).
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, glob),
          null,
          max,
        );
        if (uris.length >= max) cut = true;
        for (const uri of uris) if (uri.scheme === 'file') paths.push(uri.fsPath);
      }
      return { paths, cut };
    },
    (path) => isExcludedPath(path, 'attachment'),
    options,
  );
}

/**
 * The checker of one chat request for the string values of tool call inputs against
 * `magipilot.exclude` (phase-4-tools.md T8): `toolInputChecker` over the workspace folders, with
 * the chat matcher and the excluded files the content net found.
 */
function toolInputCheckerFor(
  guard: ExcludedContent,
  commands: readonly string[] | undefined,
): (value: string, command: boolean) => boolean {
  const patterns = excludePatterns();
  const options = platformExcludeOptions();
  const files = {
    roots: (vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === 'file')
      .map((folder) => folder.uri.fsPath),
    realpath: (path: string): string | undefined => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
    isDirectory: (path: string): boolean => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    readdir: (path: string): string[] | undefined => {
      try {
        return readdirSync(path);
      } catch {
        return undefined;
      }
    },
  };
  // The folders the conversation's command lines change to (phase-4-hardening.md AC6 b).
  const folders = commandFolders(commands, files);
  return toolInputChecker({
    ...files,
    matches: (path) =>
      isExcluded(isAbsolute(path) ? excludeMatchPath(path) : path, patterns, options),
    // A cut discovery: wildcards, directories and every command line fail closed.
    excludedPaths: guard.paths,
    excludedPathsComplete: guard.pathsComplete === true,
    key: (text) => matchKey(text, options),
    commandFolders: folders.folders,
    foldersUnknown: folders.unknown,
  });
}

function chatSettings(): ChatSettings {
  const c = config();
  return {
    claudeModels: c.get<string[]>('chat.claude.models', []),
    codexModels: c.get<string[]>('chat.codex.models', []),
    claudePath: c.get('claude.path', 'claude') || 'claude',
    codexPath: c.get('codex.path', 'codex') || 'codex',
    codexEffort: c.get<Effort>('codex.effort', 'low'),
    disableNonessentialTraffic: c.get('claude.disableNonessentialTraffic', true),
    toolCalling: c.get('chat.toolCalling', false),
    discoverModels: c.get('chat.discoverModels', true),
    contextWindowLimit: c.get<number | null>('chat.contextWindowLimit', null),
    codexMaxContextWindow: c.get('chat.codex.maxContextWindow', false),
    isExcluded: isExcludedPath,
  };
}

/** globalState key of the last good model list per CLI and path (phase-4-models.md M4). */
const DISCOVERED_MODELS_KEY = 'magipilot.discoveredModels';
/** globalState key of the hidden-model notices shown once per installation (P4M-I004). */
const DISCOVERY_NOTICES_KEY = 'magipilot.discoveryNotices';
/** globalState key of Claude's context windows per path and model (phase-4-context.md W2). */
const CLAUDE_WINDOWS_KEY = 'magipilot.chat.claudeWindows';

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const testMode = process.env.MAGIPILOT_TEST === '1';

  // Faz 0 echo models: only for the probe and the integration tests (D7).
  const probeLog = new ProbeLog(process.env.MAGIPILOT_PROBE_LOG);
  const echo = new EchoChatProvider(probeLog, testMode || !!process.env.MAGIPILOT_PROBE_LOG);

  const log = new Log(() => config().get('log.debugContent', false));
  processes = new ProcessRegistry();
  backends = new BackendRegistry({
    platform: process.platform,
    isTrusted: () => vscode.workspace.isTrusted,
    processes,
  });
  backends.configure(backendSettings());
  const registry = backends;
  const cache = new CompletionCache();
  const metrics = new Metrics();
  const status = new StatusBar(TOGGLE_COMMAND);
  const importFs = new NodeImportFs();
  // A copy the test API may change (setImportTiming); production keeps the defaults.
  const importOptions = { ...DEFAULT_IMPORT_OPTIONS };
  const provider = new InlineProvider({
    registry,
    cache,
    metrics,
    log,
    status,
    imports: new ImportContext(importFs, importOptions),
    settings: inlineSettings,
  });
  // Creating or deleting a source file may change what an import resolves to: completions made
  // with signatures are dropped (phase-3-context C10). Edits are checked on each cache hit.
  const sourceFiles = vscode.workspace.createFileSystemWatcher(
    '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py}',
    false,
    true,
    false,
  );

  const refreshStatus = (): void => {
    status.set(
      inlineSettings().enabled
        ? { kind: 'enabled', backend: backendSettings().inlineBackend }
        : { kind: 'disabled' },
    );
  };
  refreshStatus();

  // Content net: lines of excluded workspace files (phase-2-hardening.md §3). When a cap leaves
  // files out, the user is told once per pattern list (inspection HARD-I003).
  const warnedPatterns = new Set<string>();
  // Bumped with every change of the exclusion settings or the workspace folders: a chat request
  // reads the index and resolves names under one generation (FOLLOWUP-I003).
  let exclusionGeneration = 0;
  // Set only through the test API (setExclusionFaults).
  let faults: {
    indexFails?: boolean;
    unstable?: boolean;
    holdMs?: number;
    refreshAfterIndex?: boolean;
    holdModelsMs?: number;
  } = {};
  const excludedIndex = new ExcludedContentIndex({
    patterns: excludePatterns,
    options: () => platformExcludeOptions(),
    log,
    onTruncated: () => {
      const key = JSON.stringify(excludePatterns());
      if (warnedPatterns.has(key)) return;
      warnedPatterns.add(key);
      void vscode.window.showWarningMessage(
        'Magipilot: magipilot.exclude matches more files than the chat filter can read, so lines ' +
          'of some excluded files may reach chat prompts when they are pasted or quoted. ' +
          'Narrow the patterns to be fully covered.',
      );
    },
  });
  // Chat models from the CLIs themselves (phase-4-models.md M1, M4): no model call. The last
  // good list per CLI and path is kept in globalState, ids and display names only (M2).
  const registryForProbes = processes;
  /** The latest discovery events, meta only (test API). */
  const discoveryEvents: object[] = [];
  const storedModels = (): Record<string, unknown> =>
    context.globalState.get<Record<string, unknown>>(DISCOVERED_MODELS_KEY) ?? {};
  const discovery = new ModelDiscovery({
    probe: (cli, path) =>
      cli === 'claude'
        ? probeClaudeModels(registryForProbes, path, {
            disableNonessentialTraffic: chatSettings().disableNonessentialTraffic,
          })
        : probeCodexModels(registryForProbes, path),
    store: {
      get: (key) => storedModels()[key],
      set: (key, models: DiscoveredModel[]) => {
        // The sanitized fields, effort levels and windows included (phase-4-effort.md E4,
        // phase-4-context.md W6).
        const kept = models.map(
          ({ id, displayName, efforts, defaultEffort, contextWindow, maxContextWindow }) => ({
            id,
            displayName,
            ...(efforts ? { efforts } : {}),
            ...(defaultEffort ? { defaultEffort } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxContextWindow ? { maxContextWindow } : {}),
          }),
        );
        void context.globalState.update(DISCOVERED_MODELS_KEY, { ...storedModels(), [key]: kept });
      },
    },
    onChange: () => chat?.modelsChanged(),
    // Claude's privacy setting changes its answer for real (3 models instead of 12): a shorter
    // list under another value is taken at once (P4DF-006).
    environment: (cli) =>
      cli === 'claude' && chatSettings().disableNonessentialTraffic ? 'private' : '',
    log: (event) => {
      discoveryEvents.push(event);
      if (discoveryEvents.length > 50) discoveryEvents.shift();
      if (event.failure) log.warn('model discovery', event);
      else log.info('model discovery', event);
    },
  });
  const shownNotices = (): string[] =>
    context.globalState.get<string[]>(DISCOVERY_NOTICES_KEY) ?? [];
  // Claude's window per model (phase-4-context.md W1, W2): read in the background with `--model`
  // and `get_context_usage`, no model call; kept per path and model for a day.
  const windowEvents: object[] = [];
  const windows = new ClaudeWindows({
    read: (path, model) =>
      probeClaudeWindow(registryForProbes, path, model, {
        disableNonessentialTraffic: chatSettings().disableNonessentialTraffic,
      }),
    store: {
      get: () => context.globalState.get(CLAUDE_WINDOWS_KEY),
      set: (stored) => void context.globalState.update(CLAUDE_WINDOWS_KEY, stored),
    },
    onChange: (shrunk) => chat?.modelsChanged(shrunk),
    assumed: assumedWindow('claude-cli'),
    log: (event) => {
      windowEvents.push(event);
      if (windowEvents.length > 50) windowEvents.shift();
      if (event.failures > 0) log.warn('model windows', event);
      else log.info('model windows', event);
    },
  });
  // The last notice shown for a chosen context size (phase-4-sizes.md S9; tests read it).
  let lastChatNotice: string | undefined;
  chat = new ChatProvider({
    notify: (text) => {
      lastChatNotice = text;
      vscode.window.setStatusBarMessage(text, 8000);
    },
    // `holdModelsMs` is a test fault (setExclusionFaults); production never sets it.
    discovery: {
      models: async (cli, path) => {
        if (faults.holdModelsMs) {
          await new Promise<void>((resolve) => setTimeout(resolve, faults.holdModelsMs));
        }
        return discovery.models(cli, path);
      },
      invalidate: () => discovery.invalidate(),
    },
    windows,
    noticeMemory: {
      has: (key) => shownNotices().includes(key),
      add: (key) =>
        void context.globalState.update(DISCOVERY_NOTICES_KEY, [...shownNotices(), key]),
    },
    processes,
    log,
    settings: chatSettings,
    isTrusted: () => vscode.workspace.isTrusted,
    guard: async () => {
      if (faults.indexFails) throw new Error('index failed (test)');
      if (faults.holdMs) await new Promise<void>((resolve) => setTimeout(resolve, faults.holdMs));
      const index = await excludedIndex.get();
      // A settings change right after the index read, before VS Code can read the models again.
      if (faults.refreshAfterIndex) chat?.refresh();
      return index;
    },
    resolveNames: (names) => resolveAttachmentNames(names, log),
    exclusionGeneration: () => (faults.unstable ? ++exclusionGeneration : exclusionGeneration),
    toolInputChecker: toolInputCheckerFor,
    echo,
  });
  const chatProvider = chat;
  const statsPanel = new StatsPanel({
    inline: () => metrics.snapshot(),
    chat: () => chatProvider.stats.snapshot(),
  });

  context.subscriptions.push(
    log,
    status,
    provider,
    sourceFiles,
    sourceFiles.onDidCreate(() => provider.sourceFilesChanged()),
    sourceFiles.onDidDelete(() => provider.sourceFilesChanged()),
    probeLog,
    excludedIndex,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      exclusionGeneration++;
      excludedIndex.invalidate();
    }),
    // One vendor per CLI: one tab each in the model picker (phase-4-context.md G1).
    vscode.lm.registerLanguageModelChatProvider(
      vendorOf('claude-cli'),
      chatProvider.forVendor('claude-cli'),
    ),
    vscode.lm.registerLanguageModelChatProvider(
      vendorOf('codex-cli'),
      chatProvider.forVendor('codex-cli'),
    ),
    { dispose: () => windows.dispose() },
    vscode.commands.registerCommand(COMMIT_ROUTING_COMMAND, async (modelId?: string) =>
      useForCommitMessages(await chatProvider.currentModels(), modelId),
    ),
    vscode.workspace.onDidGrantWorkspaceTrust(() => chatProvider.refresh()),
    vscode.commands.registerCommand('magipilot.spike.showProbeLog', () => probeLog.show()),
    // Internal: lets the probe drain in-flight requests between steps.
    vscode.commands.registerCommand('_magipilot.spike.inFlight', () => echo.inFlight),
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: 'file' }, { scheme: 'untitled' }],
      provider,
    ),
    vscode.commands.registerCommand(TOGGLE_COMMAND, async () => {
      // Write where the effective value comes from: a workspace value overrides the user value,
      // so writing Global would change nothing (inspection P1-I011).
      const fromWorkspace = config().inspect<boolean>('inline.enabled')?.workspaceValue;
      await config().update(
        'inline.enabled',
        !inlineSettings().enabled,
        fromWorkspace !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global,
      );
    }),
    vscode.commands.registerCommand('magipilot.triggerInline', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'),
    ),
    vscode.commands.registerCommand(ACCEPT_COMMAND, (backend: string) => {
      metrics.recordAccepted(backend);
    }),
    vscode.commands.registerCommand('magipilot.showLog', () => log.show()),
    statsPanel,
    vscode.commands.registerCommand('magipilot.showStats', () => statsPanel.show()),
    vscode.commands.registerCommand('magipilot.resetStats', () => {
      metrics.reset();
      chatProvider.stats.reset();
      statsPanel.refresh();
      log.info('stats reset', {});
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('magipilot')) return;
      if (event.affectsConfiguration('magipilot.exclude')) {
        exclusionGeneration++;
        excludedIndex.invalidate();
      }
      if (
        event.affectsConfiguration('magipilot.chat') ||
        event.affectsConfiguration('magipilot.claude') ||
        event.affectsConfiguration('magipilot.codex')
      ) {
        chatProvider.refresh();
      }
      provider.invalidate();
      // Backend settings bump the generation (and rebuild backends); any other change may alter
      // what a completion would be, so cached completions are dropped as well.
      registry.configure(backendSettings());
      cache.clear();
      refreshStatus();
    }),
  );

  log.info('activated', {
    backend: backendSettings().inlineBackend,
    trusted: vscode.workspace.isTrusted,
  });
  // Utility settings that name a Codex model by its id from before the vendor split (G2).
  void migrateUtilityModels(log).catch(() => undefined);

  if (!testMode) return undefined;
  return {
    setBackendOverride: (backend) => {
      provider.invalidate();
      registry.setOverride(backend);
      cache.clear();
    },
    provider,
    metrics,
    watchdogPid: () => processes?.watchdogPid,
    statusState: () => status.state,
    chatRecords: () => chatProvider.records,
    chatInFlight: () => chatProvider.inFlight,
    chatPartsInFlight: () => chatProvider.partsInFlight,
    invalidateExcludedIndex: () => excludedIndex.invalidate(),
    chatHiddenNotices: () => chatProvider.hiddenModelNotices,
    statsHtml: () => statsPanel.html,
    echoRequestSizes: () => echo.sizes,
    chatCliCallsStarted: () => chatProvider.cliCallsStarted,
    chatModelInfo: () =>
      Promise.resolve(
        chatProvider.provideLanguageModelChatInformation(
          { silent: true },
          new vscode.CancellationTokenSource().token,
        ),
      ),
    setImportTiming: ({ delayMs, deadlineMs, dependencyCheckMs }) => {
      importFs.delayMs = delayMs;
      importOptions.deadlineMs = deadlineMs ?? DEFAULT_IMPORT_OPTIONS.deadlineMs;
      importOptions.dependencyCheckMs =
        dependencyCheckMs ?? DEFAULT_IMPORT_OPTIONS.dependencyCheckMs;
    },
    setExclusionFaults: (next) => {
      faults = { ...next };
    },
    discoveryEvents: () => [...discoveryEvents],
    discoveryNotices: () => shownNotices(),
    clearWindows: async () => {
      // No queued read starts, and the running ones end first (their fake CLI writes test logs).
      windows.invalidate();
      await windows.settle();
      await context.globalState.update(CLAUDE_WINDOWS_KEY, undefined);
      windows.clear();
      chatProvider.refresh();
    },
    windowEvents: () => [...windowEvents],
    forgetChatModels: () => chatProvider.forgetOfferedModels(),
    notifyModelsChanged: () => chatProvider.modelsChanged(),
    migrateUtilityModels: () => migrateUtilityModels(log),
    lastChatNotice: () => lastChatNotice,
    chatConversation: async (modelId, configuration, turns, tools) => {
      const token = new vscode.CancellationTokenSource().token;
      const found = (
        await chatProvider.provideLanguageModelChatInformation({ silent: true }, token)
      ).find((model) => model.id === modelId);
      if (!found) throw new Error(`model ${modelId} not found`);
      const parts: string[] = [];
      await chatProvider.provideLanguageModelChatResponse(
        found,
        turns.map(conversationMessage),
        {
          ...(configuration ? { modelConfiguration: configuration } : {}),
          tools: tools ?? [],
          toolMode: vscode.LanguageModelChatToolMode.Auto,
        },
        {
          report: (part) => {
            if (part instanceof vscode.LanguageModelTextPart) parts.push(part.value);
          },
        },
        token,
      );
      return parts;
    },
    chatRequestWithConfiguration: async (modelId, configuration, text, tools, replaced) => {
      const token = new vscode.CancellationTokenSource().token;
      const found = (
        await chatProvider.provideLanguageModelChatInformation({ silent: true }, token)
      ).find((model) => model.id === modelId);
      if (!found) throw new Error(`model ${modelId} not found`);
      const info = { ...found, ...replaced };
      const parts: string[] = [];
      await chatProvider.provideLanguageModelChatResponse(
        info,
        [vscode.LanguageModelChatMessage.User(text)],
        {
          modelConfiguration: configuration,
          tools: tools ?? [],
          toolMode: vscode.LanguageModelChatToolMode.Auto,
        } as unknown as vscode.ProvideLanguageModelChatResponseOptions,
        {
          report: (part) => {
            if (part instanceof vscode.LanguageModelTextPart) parts.push(part.value);
          },
        },
        token,
      );
      return parts;
    },
    clearDiscoveredModels: async () => {
      await context.globalState.update(DISCOVERED_MODELS_KEY, undefined);
      await context.globalState.update(DISCOVERY_NOTICES_KEY, undefined);
      discovery.clear();
      chatProvider.refresh();
    },
  };
}

/** Kills every CLI process (pools included) and closes the watchdog (AGENTS rule 8). */
export function deactivate(): void {
  chat?.dispose();
  chat = undefined;
  backends?.dispose();
  backends = undefined;
  processes?.dispose();
  processes = undefined;
}
