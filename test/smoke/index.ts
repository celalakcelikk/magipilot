// P10 (docs/plans/phase-1.md): runs inside VS Code, launched by scripts/smoke-processes.mjs.
// Uses the real backend registry with `magipilot.claude.path` pointing at the fake CLI: a few
// completions (warm pool of 2), then one request left in flight when VS Code closes.
import { execFileSync } from 'node:child_process';
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
  // The watchdog runs as Electron-as-node (`<execPath> -e …`, ELECTRON_RUN_AS_NODE=1).
  const watchdogPid = api.watchdogPid();
  let watchdogAlive = false;
  let watchdogCommand = '';
  if (watchdogPid !== undefined) {
    try {
      process.kill(watchdogPid, 0);
      watchdogAlive = true;
      watchdogCommand = execFileSync('ps', ['-o', 'command=', '-p', String(watchdogPid)], {
        encoding: 'utf8',
      })
        .trim()
        .slice(0, 120);
    } catch {
      watchdogAlive = false;
    }
  }

  // A request still running at shutdown: spares switch to "hang" and get a message.
  writeFileSync(modeFile, 'hang');
  void provide(new vscode.Position(1, 0));
  if (process.env.MAGIPILOT_SMOKE_REAL === '1') {
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
    watchdogPid,
    watchdogAlive,
    watchdogCommand,
    completions,
    aliveAfterCompletions,
    hungRequest: logEntries(fakeLog).some((entry) => entry.hung === true),
    aliveAtShutdown: alive(marker),
    metrics: api.metrics.snapshot(),
  };
  writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
  // Crash variant: the extension host dies without deactivate(); only the watchdog can clean up.
  if (crash) process.kill(process.pid, 'SIGKILL');
  // Otherwise returning ends the test run; VS Code then closes with the request still in flight.
}
