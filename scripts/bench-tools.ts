// `npm run bench:tools` (docs/plans/phase-4-tools.md AC9, T10b): the cost of tool calling with the
// real CLIs. Per backend and sample, a 2-step agent scenario (the model asks for read_file, then
// answers from its result) and an Ask-mode baseline (the same question with the file attached).
// The prompts are built by the production code; the tool catalogue and Copilot's system text are
// synthetic but sized to Copilot Chat's measured agent-mode request (.bench/smoke-agent.json,
// echo model). 3 calls per backend and sample: 18 with the defaults. Writes the raw result as JSON
// and prints the markdown table for docs/bench.md.
//
//   npm run bench:tools -- [--samples N] [--only claude|codex] [--size .bench/smoke-agent.json]
//                          [--out .bench/tools-<date>.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ANSWER_SCHEMA, parseEnvelope } from '../src/core/backends/structured';
import { totalInputTokens } from '../src/core/process/claudeStream';
import { buildClaudeArgs } from '../src/core/process/cliArgs';
import { runClaudeOnce, runCodexOnce } from '../src/core/process/oneShot';
import { ProcessRegistry } from '../src/core/process/runner';
import {
  newToolNonce,
  toCliPrompt,
  toolTurns,
  type ChatTurn,
  type CliPrompt,
  type RequestMessage,
  type ToolSpec,
} from '../src/features/chat/messages';

const FILE = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';
const QUERY =
  'Use your file-reading tool to read src/math.ts in this workspace. Then reply in one sentence that names the function the file exports.';
const CLAUDE_MODEL = 'haiku';
const CODEX_MODEL = 'gpt-6-luna';
const TIMEOUT_MS = 180_000;

interface Size {
  tools: number;
  catalogueChars: number;
  systemChars: number;
}

interface Step {
  ok: boolean;
  wallMs: number;
  inputTokens?: number;
  outputTokens?: number;
  promptChars: number;
  /** Tool names the model asked for (tool steps). */
  calls?: string[];
  /** The answer names the exported function (final and Ask steps). */
  namesAdd?: boolean;
  failure?: string;
}

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function measuredSize(path: string): Size {
  const summary = JSON.parse(readFileSync(path, 'utf8')) as { inside?: { echo?: Size } };
  const echo = summary.inside?.echo;
  if (!echo || !(echo.tools > 0)) {
    throw new Error(`${path} has no agent-mode request size: run npm run smoke:agent first`);
  }
  return { tools: echo.tools, catalogueChars: echo.catalogueChars, systemChars: echo.systemChars };
}

/** Plain filler text of about `chars` characters (a stand-in for Copilot's instructions). */
function filler(chars: number, sentence: string): string {
  return sentence.repeat(Math.max(1, Math.ceil(chars / sentence.length))).slice(0, chars);
}

/** A catalogue of `size.tools` tools of about `size.catalogueChars` characters, read_file first. */
function catalogue(size: Size): ToolSpec[] {
  const read: ToolSpec = {
    name: 'read_file',
    description: 'Read the contents of a file of the workspace.',
    inputSchema: {
      type: 'object',
      properties: { filePath: { type: 'string', description: 'Path of the file to read' } },
      required: ['filePath'],
    },
  };
  const readChars =
    read.name.length + read.description.length + JSON.stringify(read.inputSchema).length;
  const others = Math.max(0, size.tools - 1);
  const schema = { type: 'object', properties: { input: { type: 'string' } } };
  const per = others > 0 ? Math.max(40, Math.floor((size.catalogueChars - readChars) / others)) : 0;
  const tools = [read];
  for (let i = 0; i < others; i++) {
    const name = `editor_tool_${i}`;
    const descriptionChars = Math.max(20, per - name.length - JSON.stringify(schema).length);
    tools.push({
      name,
      description: filler(descriptionChars, 'Performs an editor operation on the workspace. '),
      inputSchema: schema,
    });
  }
  return tools;
}

interface Backend {
  name: 'claude' | 'codex';
  structured(cli: CliPrompt): Promise<{ step: Step; raw?: unknown }>;
  plain(cli: CliPrompt): Promise<{ step: Step; text?: string }>;
}

function backends(registry: ProcessRegistry): Backend[] {
  const claude: Backend = {
    name: 'claude',
    async structured(cli) {
      const run = await runClaudeOnce(registry, {
        args: buildClaudeArgs({
          model: CLAUDE_MODEL,
          systemPrompt: cli.system,
          partialMessages: false,
          jsonSchema: JSON.stringify(ANSWER_SCHEMA),
        }),
        prompt: cli.prompt,
        timeoutMs: TIMEOUT_MS,
      });
      const turn = run.reader.turns.at(-1);
      return {
        raw: turn?.structuredOutput,
        step: {
          ok: run.process.exitCode === 0 && turn !== undefined && !turn.isError,
          wallMs: run.endedAt - run.promptSentAt,
          inputTokens: turn?.usage ? totalInputTokens(turn.usage) : undefined,
          outputTokens: turn?.usage?.outputTokens,
          promptChars: cli.system.length + cli.prompt.length,
        },
      };
    },
    async plain(cli) {
      const run = await runClaudeOnce(registry, {
        args: buildClaudeArgs({ model: CLAUDE_MODEL, systemPrompt: cli.system }),
        prompt: cli.prompt,
        timeoutMs: TIMEOUT_MS,
      });
      const turn = run.reader.turns.at(-1);
      return {
        text: turn?.text,
        step: {
          ok: run.process.exitCode === 0 && turn !== undefined && !turn.isError,
          wallMs: run.endedAt - run.promptSentAt,
          inputTokens: turn?.usage ? totalInputTokens(turn.usage) : undefined,
          outputTokens: turn?.usage?.outputTokens,
          promptChars: cli.system.length + cli.prompt.length,
        },
      };
    },
  };
  const codexRun = async (
    cli: CliPrompt,
    outputSchema?: object,
  ): Promise<{ step: Step; text?: string }> => {
    const run = await runCodexOnce(registry, {
      model: CODEX_MODEL,
      effort: 'low',
      profile: 'lean',
      ignoreUserConfig: true,
      prompt: `${cli.system}\n\n${cli.prompt}`,
      timeoutMs: TIMEOUT_MS,
      outputSchema,
    });
    const usage = run.reader.usage;
    return {
      text: run.lastMessage ?? run.reader.text,
      step: {
        ok: run.process.exitCode === 0 && !run.reader.failed,
        wallMs: run.endedAt - run.startedAt,
        inputTokens: usage?.inputTokens,
        outputTokens: usage ? usage.outputTokens + usage.reasoningOutputTokens : undefined,
        promptChars: cli.system.length + cli.prompt.length + 2,
      },
    };
  };
  const codex: Backend = {
    name: 'codex',
    async structured(cli) {
      const { step, text } = await codexRun(cli, ANSWER_SCHEMA);
      return { step, raw: text };
    },
    plain: (cli) => codexRun(cli),
  };
  return [claude, codex];
}

function withEnvelope(step: Step, raw: unknown): { step: Step; message?: string } {
  try {
    const answer = parseEnvelope(raw);
    return {
      step: { ...step, calls: answer.toolCalls.map((c) => c.name) },
      message: answer.message,
    };
  } catch (err) {
    return { step: { ...step, ok: false, failure: (err as Error).message } };
  }
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

async function main(): Promise<void> {
  const samples = Number(arg('samples') ?? 3);
  const only = arg('only');
  const sizePath = arg('size') ?? '.bench/smoke-agent.json';
  const out = arg('out') ?? `.bench/tools-${new Date().toISOString().slice(0, 10)}.json`;
  const size = measuredSize(sizePath);
  const tools = catalogue(size);
  const system = filler(
    size.systemChars,
    'You are an expert coding assistant working in the editor. Follow the instructions, keep answers short, and use the tools when they help. ',
  );
  const registry = new ProcessRegistry();
  registry.installExitHandlers();
  const rows: Record<string, unknown>[] = [];
  try {
    for (const backend of backends(registry)) {
      if (only && only !== backend.name) continue;
      for (let sample = 0; sample < samples; sample++) {
        // Step 1: the model sees the catalogue and asks for read_file.
        const nonce = newToolNonce();
        const first: RequestMessage[] = [
          { role: 'system', parts: [{ kind: 'text', text: system }] },
          { role: 'user', parts: [{ kind: 'text', text: QUERY }] },
        ];
        const toolOptions = { toolNonce: nonce, tools: { specs: tools, required: false } };
        const cli1 = toCliPrompt(
          toolTurns(first, nonce, () => false),
          () => false,
          undefined,
          toolOptions,
        );
        const one = await backend.structured(cli1);
        const step1 = one.step.ok ? withEnvelope(one.step, one.raw).step : one.step;
        // Step 2: the editor ran read_file; the model answers from the result.
        const second: RequestMessage[] = [
          ...first,
          {
            role: 'assistant',
            parts: [
              {
                kind: 'toolCall',
                callId: 'call_bench',
                name: 'read_file',
                input: { filePath: 'src/math.ts' },
              },
            ],
          },
          { role: 'user', parts: [{ kind: 'toolResult', callId: 'call_bench', texts: [FILE] }] },
        ];
        const cli2 = toCliPrompt(
          toolTurns(second, nonce, () => false),
          () => false,
          undefined,
          toolOptions,
        );
        const two = await backend.structured(cli2);
        const final = two.step.ok ? withEnvelope(two.step, two.raw) : { step: two.step };
        const step2: Step = {
          ...final.step,
          namesAdd: final.message !== undefined ? /\badd\b/.test(final.message) : undefined,
        };
        // Ask baseline: the same question with the file attached, no tools.
        const askTurns: ChatTurn[] = [
          { role: 'system', text: system },
          { role: 'user', text: `${QUERY}\n\n// filepath: src/math.ts\n${FILE}` },
        ];
        const ask = await backend.plain(toCliPrompt(askTurns, () => false));
        const askStep: Step = {
          ...ask.step,
          namesAdd: ask.text !== undefined ? /\badd\b/.test(ask.text) : undefined,
        };
        const row = { backend: backend.name, sample, step1, step2, ask: askStep };
        rows.push(row);
        console.error(`[bench:tools] ${JSON.stringify(row)}`);
      }
    }
  } finally {
    registry.dispose();
  }

  const summary: Record<string, unknown> = {};
  for (const name of ['claude', 'codex']) {
    const mine = rows.filter((r) => r.backend === name) as {
      step1: Step;
      step2: Step;
      ask: Step;
    }[];
    if (mine.length === 0) continue;
    const pick = (
      key: 'step1' | 'step2' | 'ask',
      field: 'wallMs' | 'inputTokens' | 'outputTokens',
    ) => median(mine.map((r) => r[key][field]).filter((v): v is number => typeof v === 'number'));
    summary[name] = {
      samples: mine.length,
      step1Ok: mine.filter((r) => r.step1.ok && r.step1.calls?.includes('read_file')).length,
      step2Ok: mine.filter((r) => r.step2.ok && r.step2.namesAdd).length,
      askOk: mine.filter((r) => r.ask.ok && r.ask.namesAdd).length,
      p50: {
        step1: {
          wallMs: pick('step1', 'wallMs'),
          inputTokens: pick('step1', 'inputTokens'),
          outputTokens: pick('step1', 'outputTokens'),
        },
        step2: {
          wallMs: pick('step2', 'wallMs'),
          inputTokens: pick('step2', 'inputTokens'),
          outputTokens: pick('step2', 'outputTokens'),
        },
        ask: {
          wallMs: pick('ask', 'wallMs'),
          inputTokens: pick('ask', 'inputTokens'),
          outputTokens: pick('ask', 'outputTokens'),
        },
      },
      promptChars: {
        step1: mine[0]!.step1.promptChars,
        step2: mine[0]!.step2.promptChars,
        ask: mine[0]!.ask.promptChars,
      },
    };
  }
  const result = {
    generatedAt: new Date().toISOString(),
    models: { claude: CLAUDE_MODEL, codex: CODEX_MODEL },
    size,
    catalogueChars: tools.reduce(
      (sum, t) => sum + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length,
      0,
    ),
    summary,
    rows,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`written: ${out}`);
  console.log(
    '| Backend | Step | p50 wall | p50 input tokens | p50 output tokens | prompt chars | ok |',
  );
  console.log('|---|---|---|---|---|---|---|');
  for (const [name, value] of Object.entries(summary)) {
    const s = value as {
      samples: number;
      step1Ok: number;
      step2Ok: number;
      askOk: number;
      p50: Record<string, { wallMs?: number; inputTokens?: number; outputTokens?: number }>;
      promptChars: Record<string, number>;
    };
    const ok: Record<string, number> = { step1: s.step1Ok, step2: s.step2Ok, ask: s.askOk };
    for (const step of ['step1', 'step2', 'ask']) {
      const p = s.p50[step]!;
      console.log(
        `| ${name} | ${step} | ${p.wallMs !== undefined ? (p.wallMs / 1000).toFixed(1) : '–'} s | ${p.inputTokens ?? '–'} | ${p.outputTokens ?? '–'} | ${s.promptChars[step]} | ${ok[step]}/${s.samples} |`,
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
