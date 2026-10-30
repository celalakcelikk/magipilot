// §7 probe (npm run probe:chat). Runs inside an isolated VS Code stable instance launched by
// scripts/probe-chat.mjs and answers the PLAN §7 questions with the echo models.
// Every step embeds its own marker in the request it triggers; a step passes only when a
// `complete` (or, for cancellation, `cancelled`) record with that marker and the expected model
// reaches the provider. See docs/plans/phase-0.md §4.4.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  makeNonce,
  matchStep,
  parseProbeLog,
  type ProbePhase,
  type ProbeRecord,
} from '../../src/spike/probeRecord';

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  add(paths: string[]): Promise<void>;
  status(): Promise<void>;
}

interface GitApi {
  readonly repositories: GitRepository[];
}

interface StepResult {
  id: string;
  question: string;
  description: string;
  nonce: string;
  expectedModel: string;
  expectedPhase: ProbePhase;
  /** providerMatched && (observationAccepted ?? true). */
  passed: boolean;
  /** A record with this step's marker, the expected model and the expected phase arrived. */
  providerMatched: boolean;
  /** Result of the step's acceptance condition on its observations, if it has one. */
  observationAccepted?: boolean;
  matched?: ProbeRecord;
  sameNonceOther: ProbeRecord[];
  foreignRecordsDuringStep: number;
  actionError?: string;
  observations?: Record<string, unknown>;
  durationMs: number;
}

const VENDOR = 'magipilot';
const ECHO = 'magipilot-echo';
const ECHO_TOOLS = 'magipilot-echo-tools';
const ECHO_SLOW = 'magipilot-echo-slow';
const QUALIFIED = {
  [ECHO]: 'Magipilot Echo (probe) (magipilot)',
  [ECHO_TOOLS]: 'Magipilot Echo+Tools (probe) (magipilot)',
} as const;
const STEP_TIMEOUT_MS = 30_000;

const logPath = process.env.MAGIPILOT_PROBE_LOG ?? '';
const resultsPath = process.env.MAGIPILOT_PROBE_RESULTS ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLog(): ProbeRecord[] {
  return existsSync(logPath) ? parseProbeLog(readFileSync(logPath, 'utf8')) : [];
}

function message(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

async function withTimeout<T>(promise: Thenable<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tryCommand(command: string, ...args: unknown[]): Promise<string | undefined> {
  try {
    await withTimeout(vscode.commands.executeCommand(command, ...args), 5000, command);
    return undefined;
  } catch (err) {
    return message(err);
  }
}

async function setSetting(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);
}

async function drain(): Promise<number> {
  const deadline = Date.now() + 10_000;
  let inFlight = await vscode.commands.executeCommand<number>('_magipilot.spike.inFlight');
  while (inFlight > 0 && Date.now() < deadline) {
    await sleep(100);
    inFlight = await vscode.commands.executeCommand<number>('_magipilot.spike.inFlight');
  }
  return inFlight;
}

async function resetUi(): Promise<void> {
  await tryCommand('workbench.action.chat.cancel');
  await tryCommand('workbench.action.chat.newChat');
  await tryCommand('workbench.action.closeAllEditors');
  await drain();
}

async function waitForRecords(
  since: number,
  done: (records: ProbeRecord[]) => boolean,
  timeoutMs: number,
): Promise<ProbeRecord[]> {
  const deadline = Date.now() + timeoutMs;
  let records = readLog().slice(since);
  while (!done(records) && Date.now() < deadline) {
    await sleep(200);
    records = readLog().slice(since);
  }
  return records;
}

const steps: StepResult[] = [];

async function step(options: {
  id: string;
  question: string;
  description: string;
  expectedModel: string;
  expectedPhase?: ProbePhase;
  action: (nonce: string) => Promise<void>;
  observe?: (nonce: string) => Promise<Record<string, unknown>>;
  /**
   * Step-specific condition on the observations that must hold in addition to the matching
   * provider record (e.g. Q3: the step's marker must be in the SCM input box).
   */
  accept?: (observations: Record<string, unknown>) => boolean;
}): Promise<StepResult> {
  await resetUi();
  const nonce = makeNonce((bytes) => randomBytes(bytes).toString('hex'));
  const expectedPhase = options.expectedPhase ?? 'complete';
  const since = readLog().length;
  const startedAt = Date.now();
  let actionError: string | undefined;
  try {
    await withTimeout(options.action(nonce), STEP_TIMEOUT_MS, options.id);
  } catch (err) {
    actionError = message(err);
  }
  const remaining = Math.max(1000, STEP_TIMEOUT_MS - (Date.now() - startedAt));
  const records = await waitForRecords(
    since,
    (rs) => matchStep(rs, { nonce, modelId: options.expectedModel, phase: expectedPhase }).passed,
    remaining,
  );
  const match = matchStep(records, { nonce, modelId: options.expectedModel, phase: expectedPhase });
  let observations: Record<string, unknown> | undefined;
  try {
    observations = await options.observe?.(nonce);
  } catch (err) {
    observations = { observeError: message(err) };
  }
  // An observation that failed or is missing never satisfies an acceptance condition.
  const observationAccepted = options.accept
    ? observations !== undefined &&
      !('observeError' in observations) &&
      options.accept(observations)
    : true;
  const result: StepResult = {
    id: options.id,
    question: options.question,
    description: options.description,
    nonce,
    expectedModel: options.expectedModel,
    expectedPhase,
    passed: match.passed && observationAccepted,
    providerMatched: match.passed,
    observationAccepted: options.accept ? observationAccepted : undefined,
    matched: match.matched,
    sameNonceOther: match.sameNonceOther,
    foreignRecordsDuringStep: match.foreign,
    actionError,
    observations,
    durationMs: Date.now() - startedAt,
  };
  steps.push(result);
  return result;
}

async function gitRepository(): Promise<GitRepository> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!extension) throw new Error('vscode.git extension not found');
  const api = (await extension.activate()).getAPI(1);
  const deadline = Date.now() + 15_000;
  while (api.repositories.length === 0 && Date.now() < deadline) await sleep(200);
  const repo = api.repositories[0];
  if (!repo) throw new Error('no git repository opened');
  return repo;
}

async function openTsDocument(): Promise<vscode.TextEditor> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('no workspace folder');
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.joinPath(folder.uri, 'src', 'probe.ts'),
  );
  const editor = await vscode.window.showTextDocument(document);
  const position = new vscode.Position(1, 0);
  editor.selection = new vscode.Selection(position, position);
  return editor;
}

async function chatAsk(query: string, modelId: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query,
    mode: 'ask',
    modelSelector: { vendor: VENDOR, id: modelId },
  });
}

export async function run(): Promise<void> {
  const copilot = vscode.extensions.all.find(
    (e) => (e.packageJSON as { name?: string }).name === 'copilot-chat',
  );
  let githubSession: string;
  try {
    const session = await vscode.authentication.getSession('github', ['user:email'], {
      silent: true,
    });
    githubSession = session ? 'present' : 'none';
  } catch (err) {
    githubSession = `error: ${message(err)}`;
  }
  if (copilot && !copilot.isActive) {
    try {
      await withTimeout(copilot.activate(), 20_000, 'copilot activation');
    } catch {
      /* recorded through isActive below */
    }
  }
  const context: Record<string, unknown> = {
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    copilotChat: copilot
      ? {
          id: copilot.id,
          version: (copilot.packageJSON as { version?: string }).version,
          isActive: copilot.isActive,
        }
      : null,
    copilotLikeExtensions: vscode.extensions.all
      .filter((e) => /copilot/i.test(e.id))
      .map((e) => ({
        id: e.id,
        version: (e.packageJSON as { version?: string }).version,
        isActive: e.isActive,
      })),
    githubSession,
    magipilotModels: (await vscode.lm.selectChatModels({ vendor: VENDOR })).map((m) => m.id),
    allVendors: [...new Set((await vscode.lm.selectChatModels()).map((m) => m.vendor))],
  };

  // --- Q1: Copilot Chat on stable without GitHub sign-in ---------------------------------------
  await step({
    id: 'Q1a',
    question: 'Q1',
    description: 'vscode.lm.selectChatModels + sendRequest (LM API path, no Copilot UI)',
    expectedModel: ECHO,
    action: async (nonce) => {
      const [model] = await vscode.lm.selectChatModels({ vendor: VENDOR, id: ECHO });
      if (!model) throw new Error('magipilot-echo not found');
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(`Probe Q1a ${nonce}`)],
        {},
        new vscode.CancellationTokenSource().token,
      );
      for await (const _part of response.text) {
        /* drain */
      }
    },
  });
  // In a fresh profile, Ask-mode requests sent shortly after start-up are silently dropped (no
  // provider call at all) for ~20–90 s. Instead of a fixed wait, repeat a readiness request —
  // each attempt with its own marker, all recorded — until one reaches the provider, then judge
  // Q1b/Q1c. The time to readiness is reported.
  await tryCommand('workbench.action.chat.open');
  const readinessStartedAt = Date.now();
  let readyAfterMs: number | undefined;
  for (let attempt = 1; attempt <= 8 && readyAfterMs === undefined; attempt++) {
    const readiness = await step({
      id: `Q1-ready-${attempt}`,
      question: 'Q1',
      description: 'readiness: Ask-mode request via workbench.action.chat.open (fresh profile)',
      expectedModel: ECHO,
      action: (nonce) => chatAsk(`Magipilot probe readiness ${nonce}`, ECHO),
    });
    if (readiness.passed) readyAfterMs = Date.now() - readinessStartedAt;
  }
  context.chatReadyAfterMs = readyAfterMs ?? null;
  await step({
    id: 'Q1b',
    question: 'Q1',
    description: 'workbench.action.chat.open in Ask mode with modelSelector magipilot-echo',
    expectedModel: ECHO,
    action: (nonce) => chatAsk(`Magipilot probe Q1b ${nonce}`, ECHO),
  });
  for (const [id, focusFirst] of [
    ['Q1c', false],
    ['Q1c-focus', true],
  ] as const) {
    await step({
      id,
      question: 'Q1',
      description: `Ask mode with magipilot-echo-slow, workbench.action.chat.cancel after the first start record${focusFirst ? ' (chat input focused first)' : ''}`,
      expectedModel: ECHO_SLOW,
      expectedPhase: 'cancelled',
      action: async (nonce) => {
        const since = readLog().length;
        await chatAsk(`Magipilot probe ${id} ${nonce}`, ECHO_SLOW);
        await waitForRecords(
          since,
          (rs) => rs.some((r) => r.requestNonce === nonce && r.phase === 'start'),
          15_000,
        );
        await sleep(500);
        if (focusFirst) await tryCommand('workbench.action.chat.focusInput');
        await vscode.commands.executeCommand('workbench.action.chat.cancel');
      },
    });
  }

  // --- Q2: inline chat (Ctrl+I) -------------------------------------------------------------------
  // inlineChat.start resolves only when the inline session ends, so the step's action timeout is
  // expected; the provider record decides. `documentChanged` tells whether a text-only reply
  // (the echo models never call tools) produced any edit.
  let original = '';
  const observeDocument = (): Promise<Record<string, unknown>> => {
    const document = vscode.window.activeTextEditor?.document;
    return Promise.resolve({
      documentChanged: document ? document.getText() !== original : 'no active editor',
    });
  };
  const startInline = async (nonce: string, modelId?: string): Promise<void> => {
    const editor = await openTsDocument();
    original = editor.document.getText();
    await vscode.commands.executeCommand('inlineChat.start', {
      message: `Add a comment that says ${nonce}`,
      autoSend: true,
      ...(modelId ? { modelSelector: { vendor: VENDOR, id: modelId } } : {}),
    });
  };
  for (const [id, modelId] of [
    ['Q2a', ECHO],
    ['Q2b', ECHO_TOOLS],
  ] as const) {
    await step({
      id,
      question: 'Q2',
      description: `inlineChat.start with autoSend and modelSelector ${modelId}`,
      expectedModel: modelId,
      action: (nonce) => startInline(nonce, modelId),
      observe: observeDocument,
    });
  }
  for (const [id, modelId] of [
    ['Q2c', ECHO],
    ['Q2d', ECHO_TOOLS],
  ] as const) {
    await step({
      id,
      question: 'Q2',
      description: `inlineChat.defaultModel = "${QUALIFIED[modelId]}", inlineChat.start without modelSelector`,
      expectedModel: modelId,
      action: async (nonce) => {
        await setSetting('inlineChat.defaultModel', QUALIFIED[modelId]);
        await startInline(nonce);
      },
      observe: observeDocument,
    });
  }
  await tryCommand('workbench.action.files.revert');
  await setSetting('inlineChat.defaultModel', undefined);

  // --- Q3: commit message through the utility model ----------------------------------------------
  const repo = await gitRepository();
  const folder = vscode.workspace.workspaceFolders![0]!;
  const changeFile = join(folder.uri.fsPath, 'src', 'change.txt');
  const variants: {
    id: string;
    description: string;
    settings: Record<string, unknown>;
  }[] = [
    {
      id: 'Q3a',
      description: 'default: utility settings unset, byokUtilityModelDefault unset',
      settings: {
        'chat.utilityModel': undefined,
        'chat.utilitySmallModel': undefined,
        'chat.byokUtilityModelDefault': undefined,
      },
    },
    {
      id: 'Q3b',
      description:
        'explicit: chat.utilityModel + chat.utilitySmallModel = magipilot/magipilot-echo',
      settings: {
        'chat.utilityModel': `${VENDOR}/${ECHO}`,
        'chat.utilitySmallModel': `${VENDOR}/${ECHO}`,
        'chat.byokUtilityModelDefault': undefined,
      },
    },
    {
      id: 'Q3c',
      description: 'main agent: utility settings unset, byokUtilityModelDefault = mainAgent',
      settings: {
        'chat.utilityModel': undefined,
        'chat.utilitySmallModel': undefined,
        'chat.byokUtilityModelDefault': 'mainAgent',
      },
    },
  ];
  for (const variant of variants) {
    // Make magipilot-echo the selected main chat model before generating the commit message.
    await step({
      id: `${variant.id}-main`,
      question: 'Q3',
      description: 'select magipilot-echo as the main Ask-mode model (precondition)',
      expectedModel: ECHO,
      action: (nonce) => chatAsk(`Magipilot probe ${variant.id} main model ${nonce}`, ECHO),
    });
    for (const [key, value] of Object.entries(variant.settings)) await setSetting(key, value);
    await step({
      id: variant.id,
      question: 'Q3',
      description: `github.copilot.git.generateCommitMessage — ${variant.description}`,
      expectedModel: ECHO,
      action: async (nonce) => {
        writeFileSync(changeFile, `probe change ${nonce}\n`);
        await repo.add([changeFile]);
        await repo.status();
        repo.inputBox.value = '';
        await vscode.commands.executeCommand(
          'github.copilot.git.generateCommitMessage',
          repo.rootUri,
        );
      },
      observe: (nonce) => {
        const value = repo.inputBox.value;
        return Promise.resolve({
          scmInputContainsNonce: value.includes(nonce),
          scmInputLength: value.length,
          scmInputIsProbeReply: value.startsWith('magipilot-probe-ok:'),
          // Synthetic workspace: the box can only hold probe text or what VS Code put there.
          scmInputHead: value.slice(0, 80),
        });
      },
      // Plan §4.4 / review P0-I006: the Magipilot reply must also have reached the SCM box.
      accept: (observations) => observations.scmInputContainsNonce === true,
    });
  }
  for (const key of [
    'chat.utilityModel',
    'chat.utilitySmallModel',
    'chat.byokUtilityModelDefault',
  ]) {
    await setSetting(key, undefined);
  }

  writeFileSync(
    resultsPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), context, steps }, null, 2)}\n`,
  );
}
