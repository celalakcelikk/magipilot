// P8/P9 (docs/plans/phase-2.md): runs inside VS Code, launched by scripts/smoke-chat.mjs, against
// the REAL Claude CLI (haiku) and Codex CLI through Copilot Chat's own UI commands.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';
import type { ChatRecord } from '../../src/features/chat/provider';

const CLAUDE = 'claude-cli.haiku';
const CODEX = 'codex-cli.gpt-6-luna';
const CODE_WORD = 'ORCHID-42';
const READY_TIMEOUT_MS = 15 * 60_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  add(paths: string[]): Promise<void>;
  status(): Promise<void>;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function cliProcesses(pattern: string): number {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

/** One vendor per CLI (docs/plans/phase-4-context.md G1). */
function vendorOf(modelId: string): string {
  return modelId.startsWith('codex-cli.') ? 'magipilot-codex' : 'magipilot';
}

async function ask(query: string, modelId: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query,
    mode: 'ask',
    modelSelector: { vendor: vendorOf(modelId), id: modelId },
  });
}

export async function run(): Promise<void> {
  const resultsPath = env('MAGIPILOT_SMOKE_CHAT_RESULTS');
  const results: Record<string, unknown> = {};
  const save = (): void => writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

  const api = await vscode.extensions
    .getExtension<TestApi | undefined>('celalakcelikk.magipilot')
    ?.activate();
  if (!api) throw new Error('test API missing (MAGIPILOT_TEST=1 not set?)');
  const records = (): readonly ChatRecord[] => api.chatRecords();

  /**
   * Waits for the first finished request after `from` records that `match` accepts. Matching on
   * the model and the message count keeps a late request (e.g. a slow readiness attempt) from
   * being taken for the next step's.
   */
  const nextRecord = async (
    from: number,
    timeoutMs: number,
    match: (record: ChatRecord) => boolean = () => true,
  ): Promise<ChatRecord | undefined> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = records().slice(from).find(match);
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
  // In one session, the k-th request carries 2k messages: the system prompt, k user turns and
  // k − 1 answers.
  const turn = (modelId: string, k: number) => (record: ChatRecord) =>
    record.modelId === modelId && record.messages === 2 * k;

  // 0. Both CLI models are offered (availability probes ran).
  const until = Date.now() + 30_000;
  let ids: string[] = [];
  while (Date.now() < until) {
    ids = [
      ...(await vscode.lm.selectChatModels({ vendor: 'magipilot' })),
      ...(await vscode.lm.selectChatModels({ vendor: 'magipilot-codex' })),
    ].map((m) => m.id);
    if (ids.includes(CLAUDE) && ids.includes(CODEX)) break;
    await sleep(500);
  }
  results.models = ids;
  save();

  // 1. Readiness: a fresh profile drops Ask-mode requests for 20–90 s (Faz 0); on 2026-10-27 the
  // agent host's start-up once took over 10 minutes, so the wait is time-based.
  await vscode.commands.executeCommand('workbench.action.chat.open');
  const readyStart = Date.now();
  let ready = false;
  let readyAttempts = 0;
  while (!ready && Date.now() - readyStart < READY_TIMEOUT_MS) {
    readyAttempts++;
    const from = records().length;
    await ask('Reply with just: ready', CLAUDE);
    ready = (await nextRecord(from, 20_000))?.outcome === 'complete';
  }
  results.readyAttempts = readyAttempts;
  results.readyAfterMs = ready ? Date.now() - readyStart : null;
  save();
  if (!ready) return;
  await drain();

  // 2. Ten Ask-mode turns in one fresh session (AC2). Turn 10 asks for the code word of turn 1.
  await vscode.commands.executeCommand('workbench.action.chat.newChat');
  await sleep(1000);
  const questions = [
    `Remember this code word for later: ${CODE_WORD}. Reply with just OK.`,
    'In at most 15 words: what does Array.prototype.map do?',
    'In at most 15 words: what is a TypeScript union type?',
    'In at most 15 words: what does git rebase do?',
    'In at most 15 words: what is a closure in JavaScript?',
    'In at most 15 words: what is the difference between let and const?',
    'In at most 15 words: what does async/await do?',
    'In at most 15 words: what is a pure function?',
    'In at most 15 words: what is memoization?',
    'What was the code word I gave you at the start? Reply with just the code word.',
  ];
  const turns: ChatRecord[] = [];
  for (const [index, question] of questions.entries()) {
    const from = records().length;
    await ask(question, CLAUDE);
    const record = await nextRecord(from, 120_000, turn(CLAUDE, index + 1));
    if (!record) break;
    turns.push(record);
  }
  results.turns = turns.map(({ modelId, messages, outcome, outputChars, parts, ms, markers }) => ({
    modelId,
    messages,
    outcome,
    outputChars,
    parts,
    ms,
    recalled: markers?.[CODE_WORD],
  }));
  save();

  // 3. Model switch to Codex in the same conversation (AC4).
  {
    const from = records().length;
    await ask('In at most 10 words: what is a monad?', CODEX);
    const record = await nextRecord(from, 240_000, turn(CODEX, questions.length + 1));
    results.switchToCodex = record && {
      modelId: record.modelId,
      messages: record.messages,
      outcome: record.outcome,
      outputChars: record.outputChars,
    };
    save();
  }

  // 4. Cancel from the UI while Claude streams (AC4); afterwards no Claude CLI process is left.
  {
    const from = records().length;
    void ask(
      'Write a detailed, 300-line TypeScript implementation of a red-black tree with comments.',
      CLAUDE,
    );
    // Cancel while the answer streams: after its first part (inspection P2-I007).
    const startUntil = Date.now() + 60_000;
    while (api.chatPartsInFlight() === 0 && Date.now() < startUntil) await sleep(50);
    await vscode.commands.executeCommand('workbench.action.chat.cancel');
    const record = await nextRecord(from, 30_000, turn(CLAUDE, questions.length + 2));
    let left = cliProcesses('claude -p --tools');
    const leftUntil = Date.now() + 5000;
    while (left > 0 && Date.now() < leftUntil) {
      await sleep(200);
      left = cliProcesses('claude -p --tools');
    }
    results.cancel = record && {
      modelId: record.modelId,
      messages: record.messages,
      outcome: record.outcome,
      parts: record.parts,
      ms: record.ms,
      claudeProcessesAfter: left,
    };
    save();
  }

  // 5. Commit message through the utility models (AC3, P9).
  await drain();
  {
    const routing = await vscode.commands.executeCommand<{ effective: boolean; value?: string }>(
      'magipilot.useForCommitMessages',
      CLAUDE,
    );
    const git = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: GitRepository[] } }>(
      'vscode.git',
    );
    const gitApi = (await git!.activate()).getAPI(1);
    const repoUntil = Date.now() + 15_000;
    while (gitApi.repositories.length === 0 && Date.now() < repoUntil) await sleep(200);
    const repo = gitApi.repositories[0]!;
    const changeFile = join(repo.rootUri.fsPath, 'src', 'math.ts');
    writeFileSync(
      changeFile,
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n',
    );
    await repo.add([changeFile]);
    await repo.status();
    repo.inputBox.value = '';
    const from = records().length;
    await vscode.commands.executeCommand('github.copilot.git.generateCommitMessage', repo.rootUri);
    const record = await nextRecord(from, 120_000, (r) => r.modelId === CLAUDE);
    const boxUntil = Date.now() + 30_000;
    while (repo.inputBox.value.trim() === '' && Date.now() < boxUntil) await sleep(250);
    results.commit = {
      routing,
      providerRecord: record && {
        modelId: record.modelId,
        outcome: record.outcome,
        outputChars: record.outputChars,
      },
      scmInputLength: repo.inputBox.value.length,
    };
    save();
  }
}
