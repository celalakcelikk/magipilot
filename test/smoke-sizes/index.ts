// P5 (docs/plans/phase-4-sizes.md): runs inside VS Code, launched by scripts/smoke-sizes.mjs, with
// the fake CLI as both `claude` and `codex`, through Copilot Chat's own UI commands. Haiku's
// default context size is the 128K tier (MAGIPILOT_TEST_CONTEXT_DEFAULT); GPT-6-Luna keeps its
// full size. No real CLI call.
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ChatRecord } from '../../src/features/chat/provider';

const HAIKU = 'claude-cli.haiku';
const LUNA = 'codex-cli.gpt-6-luna';
const ASK_TURNS = 8;
const AGENT_TURNS = 2;
const READY_TIMEOUT_MS = 15 * 60_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** About 40 800 characters. */
const PAD = 'lorem ipsum '.repeat(3400);

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** One vendor per CLI (docs/plans/phase-4-context.md G1). */
function vendorOf(modelId: string): string {
  return modelId.startsWith('codex-cli.') ? 'magipilot-codex' : 'magipilot';
}

async function ask(query: string, modelId: string, mode: 'ask' | 'agent'): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query,
    mode,
    modelSelector: { vendor: vendorOf(modelId), id: modelId },
  });
}

type Info = vscode.LanguageModelChatInformation & {
  configurationSchema?: { properties: Record<string, { enum?: unknown[]; default?: unknown }> };
};

export async function run(): Promise<void> {
  const resultsPath = env('MAGIPILOT_SMOKE_SIZES_RESULTS');
  const results: Record<string, unknown> = {};
  const save = (): void => writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

  const api = await vscode.extensions
    .getExtension<TestApi | undefined>('celalakcelikk.magipilot')
    ?.activate();
  if (!api) throw new Error('test API missing (MAGIPILOT_TEST=1 not set?)');
  const records = (): readonly ChatRecord[] => api.chatRecords();
  const meta = (record: ChatRecord) => ({
    modelId: record.modelId,
    messages: record.messages,
    promptChars: record.promptChars,
    tools: record.tools,
    contextTier: record.contextTier,
    droppedMessages: record.droppedMessages,
    overTier: record.overTier,
    outcome: record.outcome,
  });
  const nextRecord = async (from: number, modelId: string, timeoutMs: number) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = records()
        .slice(from)
        .find((r) => r.modelId === modelId);
      if (found) return found;
      await sleep(250);
    }
    return undefined;
  };
  /** Waits until no request has been running for 3 s (at most 60 s). */
  const drain = async (): Promise<void> => {
    const until = Date.now() + 60_000;
    let idleSince = Date.now();
    while (Date.now() < until && Date.now() - idleSince < 3000) {
      if (api.chatInFlight() > 0) idleSince = Date.now();
      await sleep(200);
    }
  };
  /** The model information once `ready` accepts it (at most 60 s). */
  const infoWhen = async (ready: (found: Map<string, Info>) => boolean) => {
    const until = Date.now() + 60_000;
    let byId = new Map<string, Info>();
    while (Date.now() < until) {
      byId = new Map((await api.chatModelInfo()).map((m) => [m.id, m as Info]));
      if (ready(byId)) break;
      await sleep(500);
    }
    return byId;
  };

  // 0. Haiku offers the 128K tier and defaults to it (S7); its window is whatever was read or
  // assumed by then (200K assumed gives 128K and 194K).
  const byId = await infoWhen(
    (found) =>
      found.get(HAIKU)?.configurationSchema?.properties.contextTier?.default === 128_000 &&
      found.has(LUNA),
  );
  const schema = (id: string) => byId.get(id)?.configurationSchema?.properties.contextTier;
  results.models = {
    haiku: { maxInputTokens: byId.get(HAIKU)?.maxInputTokens, contextTier: schema(HAIKU) },
    luna: { maxInputTokens: byId.get(LUNA)?.maxInputTokens, contextTier: schema(LUNA) },
  };
  save();

  // 1. Readiness: a fresh profile drops Ask-mode requests for a while (Faz 0).
  await vscode.commands.executeCommand('workbench.action.chat.open');
  const readyStart = Date.now();
  let ready = false;
  let readyAttempts = 0;
  while (!ready && Date.now() - readyStart < READY_TIMEOUT_MS) {
    readyAttempts++;
    const from = records().length;
    await ask('Reply with just: ready', HAIKU, 'ask');
    ready = (await nextRecord(from, HAIKU, 20_000))?.outcome === 'complete';
  }
  results.readyAttempts = readyAttempts;
  results.readyAfterMs = ready ? Date.now() - readyStart : null;
  save();
  if (!ready) return;
  await drain();

  // 2. Ask mode: eight long turns per model in a fresh chat each.
  for (const [name, modelId] of [
    ['haiku', HAIKU],
    ['luna', LUNA],
  ] as const) {
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await sleep(1000);
    const turns: unknown[] = [];
    results[`ask-${name}`] = turns;
    for (let k = 1; k <= ASK_TURNS; k++) {
      const from = records().length;
      await ask(`TURN-${k} ${PAD}`, modelId, 'ask');
      const record = await nextRecord(from, modelId, 60_000);
      turns.push(record ? meta(record) : { k, missing: true });
      save();
      await drain();
    }
  }

  // 3. Agent mode with tool calling on: Copilot must not cut a question for the tier (D7, D8).
  await vscode.workspace
    .getConfiguration('magipilot')
    .update('chat.toolCalling', true, vscode.ConfigurationTarget.Global);
  await infoWhen(
    (found) =>
      found.get(HAIKU)?.capabilities?.toolCalling === true &&
      found.get(HAIKU)?.configurationSchema?.properties.contextTier?.default === 128_000,
  );
  await vscode.commands.executeCommand('workbench.action.chat.newChat');
  await sleep(1000);
  const agent: unknown[] = [];
  results.agent = agent;
  const agentStart = Date.now();
  for (let k = 1; k <= AGENT_TURNS; k++) {
    let found: ChatRecord | undefined;
    // The agent host may take minutes to start: the first question is asked again until a
    // request with tools arrives.
    while (!found && Date.now() - agentStart < READY_TIMEOUT_MS) {
      const from = records().length;
      await ask(`Q${k}-START ${PAD} Q${k}-END`, HAIKU, 'agent');
      const until = Date.now() + (k === 1 ? 30_000 : 120_000);
      while (!found && Date.now() < until) {
        found = records()
          .slice(from)
          .find((r) => r.modelId === HAIKU && r.tools > 0);
        if (!found) await sleep(250);
      }
      if (k > 1) break;
    }
    agent.push(found ? meta(found) : { k, missing: true });
    save();
    await drain();
  }
  await vscode.workspace
    .getConfiguration('magipilot')
    .update('chat.toolCalling', undefined, vscode.ConfigurationTarget.Global);
  save();
}
