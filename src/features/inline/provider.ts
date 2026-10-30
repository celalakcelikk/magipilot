// Inline completion provider (PLAN §6, docs/plans/phase-1.md §4.5): skip rules → cache /
// continuation → debounce → one request in flight → backend → postprocess → ghost text.
import * as vscode from 'vscode';
import { isCliFailure } from '../../core/backends/failures';
import type { BackendRegistry, Resolution } from '../../core/backends/registry';
import type { Backend } from '../../core/backends/types';
import type { CompletionCache } from '../../core/cache';
import { extractCursorContext } from '../../core/context/cursor';
import { isExcluded, platformExcludeOptions } from '../../core/context/exclude';
import type {
  DependencyCheck,
  ImportContext,
  ImportContextResult,
} from '../../core/context/importContext';
import { mergeSnippets, selectSnippets, type SnippetSource } from '../../core/context/snippets';
import { postprocess } from '../../core/postprocess';
import type { Metrics } from '../../metrics';
import type { Log } from '../../ui/log';
import type { StatusBar } from '../../ui/statusBar';
import {
  Cooldowns,
  debounceFor,
  INLINE_MAX_TOKENS,
  skipReason,
  unavailableMessage,
  type InlineSettings,
} from './rules';

export const ACCEPT_COMMAND = 'magipilot.inlineAccepted';
const ALLOWED_SCHEMES = new Set(['file', 'untitled']);
const NO_IMPORTS: ImportContextResult = { snippets: [], dependencies: [], outcome: 'ok' };

export interface InlineDeps {
  registry: BackendRegistry;
  cache: CompletionCache;
  metrics: Metrics;
  log: Log;
  status: StatusBar;
  imports: ImportContext;
  settings(): InlineSettings;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(true);
    }, ms);
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(false);
    });
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private inFlight?: AbortController;
  /** The backend call still running (it settles only after its process is gone). */
  private running?: Promise<unknown>;
  private readonly notified = new Set<string>();
  private readonly cooldowns = new Cooldowns();
  /** Bumped by invalidate(); an invocation that started in an older epoch sends nothing. */
  private epoch = 0;
  /** Bumped by every call: a cache hit that awaited its dependency check yields to a newer call. */
  private invocations = 0;
  /**
   * Bumped when a source file is created or deleted, which may change what an import resolves to:
   * a result or a cache hit that spans a change is not stored or used (CTX-I004).
   */
  private sources = 0;

  constructor(private readonly deps: InlineDeps) {}

  /**
   * The configuration changed: invocations that are debouncing, checking availability or waiting
   * for a backend become obsolete and send / show / cache nothing (inspection P1-I002).
   */
  invalidate(): void {
    this.epoch++;
    // A settings change ends every cool-down (AC4).
    this.cooldowns.clear();
    this.inFlight?.abort();
  }

  /** A TS/JS/Python file was created or deleted: completions made with signatures are dropped. */
  sourceFilesChanged(): void {
    this.sources++;
    this.deps.cache.dropWithDependencies();
  }

  /** True while `controller` is the newest request and the configuration has not changed. */
  private owns(controller: AbortController, epoch: number): boolean {
    return this.inFlight === controller && epoch === this.epoch;
  }

  /**
   * A newer call takes over from a pending request before it answers from the cache or debounces
   * (METRICS-I003): the request is aborted, and an answer it still gets is dropped as cancelled.
   * The newer call owns the status until it sends a request of its own.
   */
  private supersede(epoch: number, backend: string): void {
    if (!this.inFlight) return;
    this.inFlight.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    this.settle(controller, epoch, backend);
  }

  /** Idle status from the current setting; only the newest request may write it (P1-I017). */
  private settle(controller: AbortController, epoch: number, backend: string): void {
    if (!this.owns(controller, epoch)) return;
    this.deps.status.set(
      this.deps.settings().enabled ? { kind: 'enabled', backend } : { kind: 'disabled' },
    );
  }

  /** Workspace-relative path inside a folder, otherwise the absolute path (D10). */
  private pathOf(document: vscode.TextDocument): string {
    return vscode.workspace.asRelativePath(document.uri, false);
  }

  /** PLAN §6.2 skip rules for this document under the given settings. */
  private skipped(
    document: vscode.TextDocument,
    automatic: boolean,
    settings: InlineSettings,
  ): boolean {
    if (!ALLOWED_SCHEMES.has(document.uri.scheme)) return true;
    const editor = vscode.window.activeTextEditor;
    const hasSelection =
      editor?.document === document && editor.selections.some((selection) => !selection.isEmpty);
    const reason = skipReason({
      settings,
      automatic,
      hasSelection,
      languageId: document.languageId,
      path: this.pathOf(document),
      sizeBytes: Buffer.byteLength(document.getText(), 'utf8'),
    });
    return reason !== undefined;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const epoch = this.epoch;
    const invocation = ++this.invocations;
    const calledAt = Date.now();
    const automatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    // The manual trigger (Alt+\) tries again at once, also during a cool-down (AC4).
    if (!automatic) this.cooldowns.clear();
    if (this.skipped(document, automatic, this.deps.settings())) return [];

    const path = this.pathOf(document);
    const text = document.getText();
    const offset = document.offsetAt(position);
    const query = {
      documentUri: document.uri.toString(),
      documentText: text,
      cursorOffset: offset,
      backendGeneration: this.deps.registry.generation,
      suffixChars: this.deps.settings().maxSuffixChars,
    };
    const cached = this.deps.cache.lookup(query);
    if (cached !== undefined) {
      if (token.isCancellationRequested) return [];
      // A newer call takes over before it awaits anything: an older request still gathering
      // signatures must not send (CTX-I006).
      this.supersede(epoch, cached.backend);
      let usable = true;
      if (cached.dependencies.length > 0) {
        // Made with import signatures: only while those files are as they were read (AC3b),
        // checked asynchronously under a deadline (CTX-R004).
        const sources = this.sources;
        const check = await this.checkDependencies(cached.dependencies, token);
        if (
          token.isCancellationRequested ||
          epoch !== this.epoch ||
          invocation !== this.invocations
        )
          return [];
        if (check === 'stale') this.deps.cache.drop(cached);
        usable = check === 'current' && sources === this.sources;
      }
      if (usable) {
        // Shown means returned to VS Code, from the cache too (phase-3-metrics AC3).
        this.deps.metrics.recordShown(cached.backend, {
          fromCache: true,
          ms: Date.now() - calledAt,
        });
        return [this.item(cached.text, position, cached.backend)];
      }
    }

    const candidates = this.deps.registry.inlineCandidates();
    const primary = candidates[0];
    if (!primary) return [];
    this.supersede(epoch, primary.id);
    const debounceMs = debounceFor(this.deps.settings(), primary.id, automatic);
    if (!(await delay(debounceMs, token)) || epoch !== this.epoch) return [];

    // One request in flight (PLAN §6.5): a newer request cancels the older one and waits until
    // it has really finished — its process may take up to the SIGKILL grace to die (P1-I016).
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    const previous = this.running;
    const subscription = token.onCancellationRequested(() => controller.abort());
    let call: Promise<string> | undefined;
    try {
      if (previous) await previous.catch(() => undefined);
      if (!this.owns(controller, epoch) || controller.signal.aborted) return [];
      const backend = await this.firstUsable(
        candidates,
        () => this.owns(controller, epoch),
        automatic,
      );
      if (!backend || controller.signal.aborted || !this.owns(controller, epoch)) return [];
      const sources = this.sources;
      const importsStartedAt = Date.now();
      const imports = await this.importSignatures(document, text, controller.signal);
      const importMs = Date.now() - importsStartedAt;
      // The gathering awaited the file system: a request cancelled, superseded or made obsolete
      // meanwhile sends nothing; only its deadline goes on, without signatures (CTX-R001).
      if (controller.signal.aborted || !this.owns(controller, epoch)) return [];
      // Re-check with the settings in force right now, immediately before anything is sent: the
      // exclude list or the enabled switch may have changed while debouncing (P1-I002).
      const settings = this.deps.settings();
      if (this.skipped(document, automatic, settings)) return [];
      const { prefix, suffix } = extractCursorContext(
        text,
        offset,
        settings.maxPrefixChars,
        settings.maxSuffixChars,
      );
      const kept = settings.importSignatures
        ? imports.snippets
            .map((snippet, i) => ({ snippet, dependency: imports.dependencies[i]! }))
            .filter(
              ({ snippet }) =>
                !isExcluded(snippet.path, settings.exclude, platformExcludeOptions()),
            )
        : [];
      const snippets = mergeSnippets(
        kept.map(({ snippet }) => snippet),
        selectSnippets(prefix, this.snippetSources(document, settings), {
          exclude: settings.exclude,
        }),
      );
      const dependencies = kept.map(({ dependency }) => dependency);

      const startedAt = Date.now();
      this.deps.status.set({ kind: 'busy', backend: backend.id });
      try {
        call = backend.complete({
          prefix,
          suffix,
          languageId: document.languageId,
          filePath: path,
          snippets,
          maxTokens: INLINE_MAX_TOKENS,
          signal: controller.signal,
        });
        this.running = call;
        const raw = await call;
        const ms = Date.now() - startedAt;
        // Obsolete (settings changed) or superseded by a newer request, even if the backend
        // answered despite the abort: never cached, never shown (METRICS-I001).
        if (!this.owns(controller, epoch)) {
          this.deps.metrics.recordRequest(backend.id, 'cancelled', ms);
          return [];
        }
        const completion = postprocess(raw, {
          prefix,
          suffix,
          maxLines: settings.maxLines,
          languageId: document.languageId,
          backendKind: backend.kind,
        });
        this.settle(controller, epoch, backend.id);
        this.deps.metrics.recordRequest(
          backend.id,
          completion === null ? 'empty' : 'completion',
          ms,
        );
        this.deps.log.info('inline', {
          backend: backend.id,
          ms,
          prefixChars: prefix.length,
          suffixChars: suffix.length,
          snippets: snippets.length,
          importFiles: kept.length,
          importChars: kept.reduce((sum, { snippet }) => sum + snippet.text.length, 0),
          importMs,
          importOutcome: imports.outcome,
          rawChars: raw.length,
          chars: completion?.length ?? 0,
          outcome: completion === null ? 'empty' : 'completion',
        });
        if (completion === null) return [];
        this.deps.log.content('completion', completion);
        // Signatures read before a source file was created or deleted may name the wrong file.
        if (dependencies.length === 0 || sources === this.sources) {
          this.deps.cache.store(query, completion, backend.id, dependencies);
        }
        if (token.isCancellationRequested) return [];
        this.deps.metrics.recordShown(backend.id, { fromCache: false, ms: Date.now() - calledAt });
        return [this.item(completion, position, backend.id)];
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) {
          this.settle(controller, epoch, backend.id);
          // The request reached the backend and was cancelled or superseded.
          if (call)
            this.deps.metrics.recordRequest(backend.id, 'cancelled', Date.now() - startedAt);
          return [];
        }
        const ms = Date.now() - startedAt;
        this.deps.metrics.recordRequest(backend.id, 'error', ms);
        // A classified CLI failure carries a fixed, actionable message (phase-3-errors §4).
        const failure = isCliFailure(err) ? err : undefined;
        if (failure) this.cooldowns.start(backend.id, failure.kind);
        const detail = failure ? failure.message : `request failed: ${message(err)}`;
        const meta = failure ? { failure: failure.kind, detail: failure.detail } : {};
        if (this.owns(controller, epoch)) {
          const key = failure ? `${failure.kind}:${backend.id}` : `request:${backend.id}`;
          this.report(key, backend.id, detail, ms, meta);
        } else {
          this.deps.log.error('inline', detail, {
            backend: backend.id,
            ms,
            obsolete: true,
            ...meta,
          });
        }
        return [];
      }
    } finally {
      subscription.dispose();
      if (this.running === call) this.running = undefined;
      if (this.inFlight === controller) this.inFlight = undefined;
    }
  }

  /** Whether a cached completion's dependencies are unchanged; cancelled with the call. */
  private async checkDependencies(
    dependencies: Parameters<ImportContext['dependenciesCurrent']>[0],
    token: vscode.CancellationToken,
  ): Promise<DependencyCheck> {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    try {
      return await this.deps.imports.dependenciesCurrent(dependencies, controller.signal);
    } finally {
      subscription.dispose();
    }
  }

  /**
   * Signatures of the files the document imports, for a `file` document inside a workspace folder
   * and with the setting on (docs/plans/phase-3-context.md); empty otherwise.
   */
  private async importSignatures(
    document: vscode.TextDocument,
    text: string,
    signal: AbortSignal,
  ): Promise<ImportContextResult> {
    const settings = this.deps.settings();
    if (!settings.importSignatures || document.uri.scheme !== 'file') return NO_IMPORTS;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || folder.uri.scheme !== 'file') return NO_IMPORTS;
    return this.deps.imports.collect({
      languageId: document.languageId,
      documentText: text,
      documentPath: document.uri.fsPath,
      folderPath: folder.uri.fsPath,
      exclude: settings.exclude,
      excludeOptions: platformExcludeOptions(),
      signal,
    });
  }

  /** The primary backend, or the fallback when the primary is refused or not available. */
  private async firstUsable(
    candidates: Resolution[],
    owns: () => boolean,
    automatic: boolean,
  ): Promise<Backend | undefined> {
    for (const candidate of candidates) {
      if ('error' in candidate) {
        if (owns()) this.report(`refused:${candidate.id}`, candidate.id, candidate.error);
        continue;
      }
      // Cooling down after a not-logged-in or limit failure: no automatic request (AC4).
      if (automatic && this.cooldowns.active(candidate.id)) continue;
      if (await candidate.backend.isAvailable()) return candidate.backend;
      if (!owns()) return undefined;
      this.report(`unavailable:${candidate.id}`, candidate.id, unavailableMessage(candidate.id));
    }
    return undefined;
  }

  /** Other open tabs; excluded, oversized and non-file documents are never read (rule 6). */
  private snippetSources(document: vscode.TextDocument, settings: InlineSettings): SnippetSource[] {
    const open = new Map(vscode.workspace.textDocuments.map((doc) => [doc.uri.toString(), doc]));
    const seen = new Set<string>([document.uri.toString()]);
    const sources: SnippetSource[] = [];
    for (const tab of vscode.window.tabGroups.all.flatMap((group) => group.tabs)) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const key = tab.input.uri.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      const other = open.get(key);
      if (!other || other.languageId !== document.languageId) continue;
      if (!ALLOWED_SCHEMES.has(other.uri.scheme)) continue;
      const path = this.pathOf(other);
      if (isExcluded(path, settings.exclude, platformExcludeOptions())) continue;
      const text = other.getText();
      if (Buffer.byteLength(text, 'utf8') > settings.maxFileSizeKb * 1024) continue;
      sources.push({ path, text });
    }
    return sources;
  }

  private item(
    text: string,
    position: vscode.Position,
    backend: string,
  ): vscode.InlineCompletionItem {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position), {
      command: ACCEPT_COMMAND,
      title: 'Accept',
      arguments: [backend],
    });
  }

  /** Status bar error, details in the log, and one notification per error kind per session. */
  private report(
    kind: string,
    backend: string,
    detail: string,
    ms?: number,
    meta: Record<string, string | undefined> = {},
  ): void {
    this.deps.status.set({ kind: 'error', backend, message: detail });
    this.deps.log.error('inline', detail, { backend, ms, ...meta });
    if (this.notified.has(kind)) return;
    this.notified.add(kind);
    void vscode.window
      .showWarningMessage(`Magipilot (${backend}): ${detail}`, 'Show Log')
      .then((choice) => {
        if (choice === 'Show Log') this.deps.log.show();
      });
  }

  dispose(): void {
    this.inFlight?.abort();
  }
}
