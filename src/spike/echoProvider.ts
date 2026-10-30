// Faz 0 prototype LanguageModelChatProvider. The echo models answer the PLAN §7 routing
// questions; they never forward message content anywhere and never spawn a process.
// Replaced by the real provider in Faz 2.
import * as vscode from 'vscode';
import type { ProbeLog } from './probeLog';
import { buildProbeRecord, extractNonce, type ProbePhase } from './probeRecord';

export const VENDOR = 'magipilot';

export const ECHO_MODEL_IDS = {
  echo: 'magipilot-echo',
  echoTools: 'magipilot-echo-tools',
  echoSlow: 'magipilot-echo-slow',
} as const;

const COMMON = {
  family: 'magipilot-probe',
  version: '0.0.1',
  // Placeholder limits: the echo models have no real context window.
  maxInputTokens: 128_000,
  maxOutputTokens: 4_096,
} as const;

export const ECHO_MODELS: vscode.LanguageModelChatInformation[] = [
  {
    ...COMMON,
    id: ECHO_MODEL_IDS.echo,
    name: 'Magipilot Echo (probe)',
    detail: 'Faz 0 probe',
    tooltip: 'Replies with a fixed probe text. No content leaves VS Code.',
    capabilities: { toolCalling: false, imageInput: false },
  },
  {
    ...COMMON,
    id: ECHO_MODEL_IDS.echoTools,
    name: 'Magipilot Echo+Tools (probe)',
    detail: 'Faz 0 probe, declares tool calling',
    tooltip: 'Declares tool calling but never calls a tool. No content leaves VS Code.',
    capabilities: { toolCalling: true, imageInput: false },
  },
  {
    ...COMMON,
    id: ECHO_MODEL_IDS.echoSlow,
    name: 'Magipilot Echo Slow (probe)',
    detail: 'Faz 0 probe, streams for ~4 s',
    tooltip: 'Streams 20 parts over ~4 s; stops as soon as the request is cancelled.',
    capabilities: { toolCalling: false, imageInput: false },
  },
];

const SLOW_PARTS = 20;
const SLOW_PART_DELAY_MS = 200;

export function probeReply(nonce: string | undefined): string {
  return `magipilot-probe-ok:${nonce ?? 'manual'}`;
}

function textOf(message: vscode.LanguageModelChatRequestMessage): string[] {
  return message.content.flatMap((part) =>
    part instanceof vscode.LanguageModelTextPart ? [part.value] : [],
  );
}

function roleName(role: vscode.LanguageModelChatMessageRole): string {
  switch (role) {
    case vscode.LanguageModelChatMessageRole.User:
      return 'user';
    case vscode.LanguageModelChatMessageRole.Assistant:
      return 'assistant';
    // Copilot Chat sends its system prompt with role 3 (System), which @types/vscode 1.140
    // does not declare yet.
    case 3 as vscode.LanguageModelChatMessageRole:
      return 'system';
    default:
      return `role-${String(role)}`;
  }
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const listener = token.onCancellationRequested(done);
    function done(): void {
      clearTimeout(timer);
      listener.dispose();
      resolve();
    }
  });
}

/**
 * The size of a request the echo models received, meta only (docs/plans/phase-4-tools.md T10a):
 * how large Copilot Chat's agent-mode requests are, measured without a CLI call.
 */
export interface EchoRequestSize {
  modelId: string;
  messages: number;
  tools: number;
  /** Characters of the tool names, descriptions and input schemas (JSON). */
  catalogueChars: number;
  /** Characters of the system-role messages' text. */
  systemChars: number;
  /** Characters of all messages' text. */
  totalChars: number;
}

export class EchoChatProvider implements vscode.LanguageModelChatProvider {
  private active = 0;
  /** The last 50 request sizes (test mode only; no content). */
  readonly sizes: EchoRequestSize[] = [];

  /** @param enabled false hides the echo models (users never see them, phase-1.md D7). */
  constructor(
    private readonly log: ProbeLog,
    private readonly enabled: boolean,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  provideLanguageModelChatInformation(): vscode.LanguageModelChatInformation[] {
    return this.enabled ? ECHO_MODELS : [];
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const startedAt = Date.now();
    const texts = messages.flatMap(textOf);
    const nonce = extractNonce(texts);
    const tools = options.tools ?? [];
    this.sizes.push({
      modelId: model.id,
      messages: messages.length,
      tools: tools.length,
      catalogueChars: tools.reduce(
        (sum, tool) =>
          sum +
          tool.name.length +
          tool.description.length +
          JSON.stringify(tool.inputSchema ?? {}).length,
        0,
      ),
      systemChars: messages
        .filter((m) => roleName(m.role) === 'system')
        .flatMap(textOf)
        .reduce((sum, t) => sum + t.length, 0),
      totalChars: texts.reduce((sum, t) => sum + t.length, 0),
    });
    if (this.sizes.length > 50) this.sizes.shift();
    const record = (phase: ProbePhase): void =>
      this.log.write(
        buildProbeRecord({
          phase,
          requestNonce: nonce,
          modelId: model.id,
          roles: messages.map((m) => roleName(m.role)),
          totalChars: texts.reduce((sum, t) => sum + t.length, 0),
          toolNames: (options.tools ?? []).map((tool) => tool.name),
          toolMode: vscode.LanguageModelChatToolMode[options.toolMode] ?? String(options.toolMode),
          startedAt,
          now: Date.now(),
        }),
      );

    this.active++;
    record('start');
    try {
      const reply = probeReply(nonce);
      if (model.id === ECHO_MODEL_IDS.echoSlow) {
        for (let i = 0; i < SLOW_PARTS; i++) {
          if (token.isCancellationRequested) {
            record('cancelled');
            return;
          }
          progress.report(new vscode.LanguageModelTextPart(i === 0 ? `${reply} ` : `${i} `));
          await delay(SLOW_PART_DELAY_MS, token);
        }
        if (token.isCancellationRequested) {
          record('cancelled');
          return;
        }
      } else {
        const half = Math.ceil(reply.length / 2);
        progress.report(new vscode.LanguageModelTextPart(reply.slice(0, half)));
        progress.report(new vscode.LanguageModelTextPart(reply.slice(half)));
      }
      record('complete');
    } catch (err) {
      record('error');
      throw err;
    } finally {
      this.active--;
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    const length = typeof text === 'string' ? text.length : textOf(text).join('').length;
    return Promise.resolve(Math.ceil(length / 4));
  }
}
