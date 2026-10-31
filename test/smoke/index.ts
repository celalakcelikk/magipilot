// P10 (docs/plans/phase-1.md): runs inside VS Code, launched by scripts/smoke-processes.mjs.
// Uses the real backend registry with `magipilot.claude.path` pointing at the fake CLI: a few
// completions (warm pool of 2), then one request left in flight when VS Code closes. The real
// modes point the CLI paths at wrappers around the real CLIs (docs/plans/phase-5-linux.md D7).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function alive(marker: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

function logEntries(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The command line of `pid`, or '' once it is gone. */
function commandOf(pid: number): string {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Polls `check` every 100 ms for up to `ms`; true as soon as it holds. */
async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(100);
  }
  return check();
}

function watchdogState(api: TestApi): {
  watchdogPid: number | undefined;
  watchdogAlive: boolean;
  watchdogCommand: string;
} {
  // The watchdog runs as Electron-as-node (`<execPath> -e …`, ELECTRON_RUN_AS_NODE=1).
  const watchdogPid = api.watchdogPid();
  if (watchdogPid === undefined) return { watchdogPid, watchdogAlive: false, watchdogCommand: '' };
  try {
    process.kill(watchdogPid, 0);
  } catch {
    return { watchdogPid, watchdogAlive: false, watchdogCommand: '' };
  }
  return {
    watchdogPid,
    watchdogAlive: true,
    watchdogCommand: commandOf(watchdogPid).slice(0, 120),
  };
}

/**
 * phase-5-linux D3: one chat request each to a Claude and a Codex model through vscode.lm, with
 * the models discovery finds. The results hold ids, lengths and whether the token came back,
 * never the answer text.
 */
async function runLm(api: TestApi): Promise<void> {
  const resultsPath = env('MAGIPILOT_SMOKE_RESULTS');
  const token = `MPSMOKE${randomBytes(4).toString('hex').toUpperCase()}`;
  const wantClaude = process.env.MAGIPILOT_SMOKE_LM_CLAUDE || 'haiku';
  const wantCodex = process.env.MAGIPILOT_SMOKE_LM_CODEX || '';
  const pick = (
    models: vscode.LanguageModelChat[],
    want: string,
  ): vscode.LanguageModelChat | undefined =>
    want ? models.find((model) => model.id.endsWith(`.${want}`)) : models[0];

  let claudeModels: vscode.LanguageModelChat[] = [];
  let codexModels: vscode.LanguageModelChat[] = [];
  // Discovery fills the lists in the background (no model call); wait for both.
  const until = Date.now() + 90_000;
  // Only the CLI models: in test mode the 'magipilot' vendor also lists echo models (LINUX-I001).
  const cliModels = async (vendor: string, prefix: string) =>
    (await vscode.lm.selectChatModels({ vendor })).filter((model) => model.id.startsWith(prefix));
  while (Date.now() < until) {
    claudeModels = await cliModels('magipilot', 'claude-cli.');
    codexModels = await cliModels('magipilot-codex', 'codex-cli.');
    if (
      claudeModels.length >= 3 &&
      pick(claudeModels, wantClaude) &&
      pick(codexModels, wantCodex)
    ) {
      break;
    }
    await sleep(500);
  }

  const ask = async (model: vscode.LanguageModelChat | undefined) => {
    if (!model) return undefined;
    const started = Date.now();
    const source = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => source.cancel(), 180_000);
    let text = '';
    let error: string | undefined;
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(`Reply with exactly ${token} and nothing else.`)],
        {},
        source.token,
      );
      for await (const part of response.text) text += part;
    } catch (err) {
      // Magipilot's request errors are fixed texts per kind; they never echo the prompt.
      error = err instanceof Error ? err.message.slice(0, 200) : 'error';
    } finally {
      clearTimeout(timer);
    }
    return {
      id: model.id,
      ms: Date.now() - started,
      chars: text.length,
      tokenFound: text.includes(token),
      error,
    };
  };

  const claude = await ask(pick(claudeModels, wantClaude));
  const codex = await ask(pick(codexModels, wantCodex));
  writeFileSync(
    resultsPath,
    `${JSON.stringify(
      {
        claudeModels: claudeModels.length,
        codexModels: codexModels.length,
        modelIds: [...claudeModels, ...codexModels].map((model) => model.id),
        claude,
        codex,
        ...watchdogState(api),
        // Last, so every group started so far is listed (D7).
        startedGroups: api.startedGroups(),
      },
      null,
      2,
    )}\n`,
  );
  // Returning ends the run; VS Code closes while discovery's window probes may still be running.
}

/** C-AC4: default settings against the real Ollama — one completion, nothing for .env. */
async function runOllama(api: TestApi, folder: vscode.WorkspaceFolder): Promise<void> {
  const resultsPath = env('MAGIPILOT_SMOKE_RESULTS');
  const invoke = async (path: string, position: vscode.Position): Promise<string[]> => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, path));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const items = await api.provider.provideInlineCompletionItems(
      editor.document,
      position,
      { triggerKind: vscode.InlineCompletionTriggerKind.Invoke, selectedCompletionInfo: undefined },
      new vscode.CancellationTokenSource().token,
    );
    return items.map((item) =>
      typeof item.insertText === 'string' ? item.insertText : item.insertText.value,
    );
  };
  const completion = (await invoke('src/a.ts', new vscode.Position(3, 9)))[0] ?? '';
  const ollamaRequests = (): number => api.metrics.snapshot().ollama?.requests ?? 0;
  const afterA = ollamaRequests();
  const envItems = (await invoke('.env', new vscode.Position(0, 0))).length;
  writeFileSync(
    resultsPath,
    `${JSON.stringify(
      { completion, ollamaRequests: afterA, ollamaRequestsAfterEnv: ollamaRequests(), envItems },
      null,
      2,
    )}\n`,
  );
  if (ollamaRequests() !== afterA) throw new Error('.env caused an Ollama request');
}

export async function run(): Promise<void> {
  if (process.env.MAGIPILOT_SMOKE_OLLAMA === '1') {
    const extension = vscode.extensions.getExtension<TestApi | undefined>(
      'celalakcelikk.magipilot',
    );
    const api = await extension?.activate();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!api || !folder) throw new Error('test API or workspace missing');
    await runOllama(api, folder);
    return;
  }
  if (process.env.MAGIPILOT_SMOKE_LM === '1') {
    const extension = vscode.extensions.getExtension<TestApi | undefined>(
      'celalakcelikk.magipilot',
    );
    const api = await extension?.activate();
    if (!api) throw new Error('test API missing (MAGIPILOT_TEST=1 not set?)');
    await runLm(api);
    return;
  }
  const marker = env('MAGIPILOT_SMOKE_MARKER');
  const modeFile = env('FAKE_CLI_MODE_FILE');
  const fakeLog = env('FAKE_CLI_LOG');
  const resultsPath = env('MAGIPILOT_SMOKE_RESULTS');

  const extension = vscode.extensions.getExtension<TestApi | undefined>('celalakcelikk.magipilot');
  const api = await extension?.activate();
  if (!api) throw new Error('test API missing (MAGIPILOT_TEST=1 not set?)');
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder.uri, 'src', 'a.ts'),
  );
  const editor = await vscode.window.showTextDocument(document, { preview: false });

  const provide = (position: vscode.Position): Thenable<vscode.InlineCompletionItem[]> =>
    api.provider.provideInlineCompletionItems(
      editor.document,
      position,
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
      },
      new vscode.CancellationTokenSource().token,
    );

  // Different positions so the cache never answers.
  const completions: string[] = [];
  for (const position of [
    new vscode.Position(3, 9),
    new vscode.Position(4, 1),
    new vscode.Position(0, 0),
  ]) {
    const items = await provide(position);
    const insert = items[0]?.insertText;
    completions.push(typeof insert === 'string' ? insert : (insert?.value ?? ''));
  }
  // VS Code's own path: Alt+\ → editor.action.inlineSuggest.trigger → provider.
  editor.selection = new vscode.Selection(2, 0, 2, 0);
  await vscode.commands.executeCommand('magipilot.triggerInline');
  await sleep(1500);
  const aliveAfterCompletions = alive(marker);
  const watchdog = watchdogState(api);

  // Codex starts a cold process per request (phase-5-linux D8). Let the earlier requests end
  // first, so the process seen below belongs to the final request (inspection LINUX-I005).
  const realCodex = process.env.MAGIPILOT_SMOKE_REAL_CODEX === '1';
  const codexExecs = (): number[] =>
    alive(marker).filter((pid) => / exec( |$)/.test(commandOf(pid)));
  const earlierRequestsEnded = realCodex
    ? await waitFor(() => codexExecs().length === 0, 60_000)
    : undefined;
  const execsBefore = new Set(realCodex ? codexExecs() : []);

  // A request still running at shutdown: spares switch to "hang" and get a message.
  writeFileSync(modeFile, 'hang');
  void provide(new vscode.Position(1, 0));
  let shutdownRequestSeen: boolean | undefined;
  let shutdownPid: number | undefined;
  if (realCodex) {
    shutdownRequestSeen = await waitFor(() => {
      shutdownPid = codexExecs().find((pid) => !execsBefore.has(pid));
      return shutdownPid !== undefined;
    }, 10_000);
  } else if (process.env.MAGIPILOT_SMOKE_REAL === '1') {
    await sleep(300); // a real request is now running; close VS Code while it does
  } else {
    const until = Date.now() + 5000;
    while (!logEntries(fakeLog).some((entry) => entry.hung === true) && Date.now() < until) {
      await sleep(50);
    }
  }
  const crash = process.env.MAGIPILOT_SMOKE_CRASH === '1';
  const results = {
    crash,
    extensionHostPid: process.pid,
    ...watchdog,
    completions,
    aliveAfterCompletions,
    hungRequest: logEntries(fakeLog).some((entry) => entry.hung === true),
    earlierRequestsEnded,
    shutdownRequestSeen,
    // The final request is still running as the run ends (LINUX-I005).
    shutdownRequestAliveAtEnd:
      shutdownPid !== undefined && commandOf(shutdownPid) !== '' ? true : undefined,
    aliveAtShutdown: alive(marker),
    metrics: api.metrics.snapshot(),
    // Last, so every group started so far is listed (phase-5-linux D7).
    startedGroups: api.startedGroups(),
  };
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  // Crash variant: the extension host dies without deactivate(); only the watchdog can clean up.
  if (crash) process.kill(process.pid, 'SIGKILL');
  // Otherwise returning ends the test run; VS Code then closes with the request still in flight.
}
