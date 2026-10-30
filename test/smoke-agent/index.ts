// P7a/P8 (docs/plans/phase-4-tools.md AC9, AC10): runs inside VS Code, launched by
// scripts/smoke-agent.mjs, with magipilot.chat.toolCalling on. Measures Copilot Chat's agent-mode
// request with the echo model (no CLI call), then lets Claude (CLI) and Codex (CLI) read a file
// through Copilot's own tool in agent mode, then starts inline chat with Claude (CLI).
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ChatRecord } from '../../src/features/chat/provider';

const CLAUDE = 'claude-cli.haiku';
const CODEX = 'codex-cli.gpt-6-luna';
const ECHO_TOOLS = 'magipilot-echo-tools';
const READY_TIMEOUT_MS = 15 * 60_000;
const AGENT_TIMEOUT_MS = 6 * 60_000;
const QUERY =
  'Use your file-reading tool to read src/math.ts in this workspace. Then reply in one sentence that names the function the file exports and ends with ORCHID-42.';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** One vendor per CLI (docs/plans/phase-4-context.md G1). */
function vendorOf(modelId: string): string {
  return modelId.startsWith('codex-cli.') ? 'magipilot-codex' : 'magipilot';
}

async function ask(query: string, modelId: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query,
    mode: 'agent',
    modelSelector: { vendor: vendorOf(modelId), id: modelId },
  });
}

async function tryCommand(command: string, ...args: unknown[]): Promise<void> {
  try {
    await vscode.commands.executeCommand(command, ...args);
  } catch {
    // Not every command exists in every VS Code build; the records decide.
  }
}

const meta = (r: ChatRecord): Record<string, unknown> => ({
  modelId: r.modelId,
  messages: r.messages,
  promptChars: r.promptChars,
  tools: r.tools,
  toolCalls: r.toolCalls,
  toolMode: r.toolMode,
  outputChars: r.outputChars,
  ms: r.ms,
  outcome: r.outcome,
  markers: r.markers,
});

export async function run(): Promise<void> {
  const resultsPath = env('MAGIPILOT_SMOKE_AGENT_RESULTS');
  const maxCalls = Number(env('MAGIPILOT_SMOKE_AGENT_MAX_CALLS'));
  const results: Record<string, unknown> = {};
  const save = (): void => writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

  const api = await vscode.extensions
    .getExtension<TestApi | undefined>('celalakcelikk.magipilot')
    ?.activate();
  if (!api) throw new Error('test API missing (MAGIPILOT_TEST=1 not set?)');
  const records = (): readonly ChatRecord[] => api.chatRecords();
  // Started calls, not finished records: the provider refuses a call beyond the budget before it
  // starts (MAGIPILOT_TEST_MAX_CLI_CALLS, inspection P4T-I003); the test stops asking then.
  const cliCalls = (): number => api.chatCliCallsStarted();
  const drain = async (): Promise<void> => {
    const until = Date.now() + 60_000;
    let idleSince = Date.now();
    while (Date.now() < until && Date.now() - idleSince < 3000) {
      if (api.chatInFlight() > 0) idleSince = Date.now();
      await sleep(200);
    }
  };

  // 0. Both CLI models are offered.
  const modelsUntil = Date.now() + 30_000;
  let ids: string[] = [];
  while (Date.now() < modelsUntil) {
    ids = [
      ...(await vscode.lm.selectChatModels({ vendor: 'magipilot' })),
      ...(await vscode.lm.selectChatModels({ vendor: 'magipilot-codex' })),
    ].map((m) => m.id);
    if (ids.includes(CLAUDE) && ids.includes(CODEX) && ids.includes(ECHO_TOOLS)) break;
    await sleep(500);
  }
  results.models = ids;
  save();

  // 1. Readiness and the agent-mode request size (T10a), with the echo model: no CLI call.
  await vscode.commands.executeCommand('workbench.action.chat.open');
  const readyStart = Date.now();
  let attempts = 0;
  let measured: unknown;
  while (measured === undefined && Date.now() - readyStart < READY_TIMEOUT_MS) {
    attempts++;
    const seen = api.echoRequestSizes().length;
    await ask('Reply with just: ready', ECHO_TOOLS);
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const size = api
        .echoRequestSizes()
        .slice(seen)
        .find((s) => s.tools > 0);
      if (size) {
        measured = size;
        break;
      }
      await sleep(250);
    }
  }
  results.readyAttempts = attempts;
  results.readyAfterMs = measured ? Date.now() - readyStart : null;
  results.echo = measured;
  save();
  if (!measured) return;
  await drain();

  // 2. Agent mode with each CLI model: Copilot runs its read tool; the model answers.
  const agent: Record<string, unknown> = {};
  results.agent = agent;
  // Codex declares no tool calling (docs/bench.md, P4T-REV-002), so Copilot does not offer it in
  // agent mode; only Claude runs here.
  for (const [name, model] of [['claude', CLAUDE]] as const) {
    if (cliCalls() >= maxCalls) {
      agent[name] = { skipped: 'call budget spent' };
      continue;
    }
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await sleep(1000);
    const from = records().length;
    const startedAt = Date.now();
    await ask(QUERY, model);
    let final: ChatRecord | undefined;
    let stopped: string | undefined;
    while (!final && !stopped) {
      const mine = records()
        .slice(from)
        .filter((r) => r.modelId === model);
      final = mine.find((r) => r.outcome !== 'complete' || r.toolCalls === 0);
      if (final) break;
      if (cliCalls() >= maxCalls) stopped = 'call ceiling';
      else if (Date.now() - startedAt > AGENT_TIMEOUT_MS) stopped = 'timeout';
      else await sleep(500);
    }
    if (stopped) await vscode.commands.executeCommand('workbench.action.chat.cancel');
    await drain();
    const mine = records()
      .slice(from)
      .filter((r) => r.modelId === model);
    agent[name] = {
      requests: mine.map(meta),
      toolCallRequests: mine.filter((r) => r.toolCalls > 0).length,
      final: final && meta(final),
      stopped,
      ms: Date.now() - startedAt,
    };
    save();
  }

  // 3. Inline chat with Claude (CLI): the request reaches the provider with its edit tool, and the
  // model answers with a call. Applying the edit is Copilot's; the session is discarded.
  if (cliCalls() < maxCalls) {
    const [file] = await vscode.workspace.findFiles('src/math.ts');
    const editor = await vscode.window.showTextDocument(file!);
    editor.selection = new vscode.Selection(0, 0, 2, 1);
    const from = records().length;
    // inlineChat.start resolves only when the session ends: not awaited.
    void vscode.commands.executeCommand('inlineChat.start', {
      message: 'Rename the function add to sum.',
      autoSend: true,
      modelSelector: { vendor: 'magipilot', id: CLAUDE },
    });
    const until = Date.now() + 180_000;
    let first: ChatRecord | undefined;
    while (!first && Date.now() < until) {
      first = records()
        .slice(from)
        .find((r) => r.modelId === CLAUDE);
      if (!first) await sleep(500);
    }
    await tryCommand('inlineChat.discard');
    await tryCommand('inlineChat.close');
    await drain();
    await tryCommand('workbench.action.files.revert');
    results.inlineChat = first ? meta(first) : { reached: false };
  }
  results.cliCalls = cliCalls();
  save();
}
