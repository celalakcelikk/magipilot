// P5 of docs/plans/phase-4-tools.md: tool calling through the public LM API with the fake CLI as
// `claude` and `codex` (AC1–AC4, AC12). No real CLI is called.
import * as assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';

const FAKE = resolve(__dirname, '../../../test/fixtures/fake-cli/fake-cli.mjs');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CLAUDE = 'claude-cli.fake-a';
const CODEX = 'codex-cli.fake-c';

interface FakeEntry {
  args: string[];
  cwdEntries: string[];
  stdinMarkers?: Record<string, boolean>;
  answered?: boolean;
  version?: boolean;
  schemaExists?: boolean;
  schemaInCwd?: boolean;
}

const READ: vscode.LanguageModelChatTool = {
  name: 'read_file',
  description: 'Reads a file of the workspace.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const SEARCH: vscode.LanguageModelChatTool = {
  name: 'search',
  description: 'Searches the workspace.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
};

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('magipilot');
}

async function api(): Promise<TestApi> {
  const extension = vscode.extensions.getExtension<TestApi>('celalakcelikk.magipilot')!;
  return extension.activate();
}

async function modelById(id: string): Promise<vscode.LanguageModelChat> {
  for (let i = 0; i < 50; i++) {
    // One vendor per CLI (phase-4-context.md G1).
    const vendor = id.startsWith('codex-cli.') ? 'magipilot-codex' : 'magipilot';
    const found = (await vscode.lm.selectChatModels({ vendor })).find((m) => m.id === id);
    if (found) return found;
    await sleep(100);
  }
  throw new Error(`model ${id} did not appear`);
}

async function send(
  id: string,
  messages: vscode.LanguageModelChatMessage[],
  options: vscode.LanguageModelChatRequestOptions,
): Promise<unknown[]> {
  const response = await (
    await modelById(id)
  ).sendRequest(messages, options, new vscode.CancellationTokenSource().token);
  const parts: unknown[] = [];
  for await (const part of response.stream) parts.push(part);
  return parts;
}

/** A conversation where the model read `path` and the editor answered with `result`. */
function readConversation(path: string, result: string): vscode.LanguageModelChatMessage[] {
  return [
    vscode.LanguageModelChatMessage.User('What does the file say?'),
    vscode.LanguageModelChatMessage.Assistant([
      new vscode.LanguageModelToolCallPart('call_t1', 'read_file', { path }),
    ]),
    vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart('call_t1', [new vscode.LanguageModelTextPart(result)]),
    ]),
  ];
}

describe('Magipilot chat tool calling (fake CLI)', () => {
  let logDir: string;
  let logFile: string;
  let root: string;
  let dir: string;

  const requests = (): FakeEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeEntry)
          .filter((e) => !e.version)
      : [];
  const answered = (): FakeEntry => requests().find((e) => e.answered)!;

  before(async () => {
    const global = vscode.ConfigurationTarget.Global;
    await config().update('claude.path', FAKE, global);
    await config().update('codex.path', FAKE, global);
    await config().update('chat.claude.models', ['fake-a'], global);
    await config().update('chat.codex.models', ['fake-c'], global);
    await config().update('chat.toolCalling', true, global);
    root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    dir = join(root, 'tooltest');
    // Excluded files whose lines are all shorter than the content net's 8 characters (T8).
    mkdirSync(join(dir, 'sp ace'), { recursive: true });
    writeFileSync(join(dir, '.env.short'), 'Q7=z\nW8=y\n');
    writeFileSync(join(dir, 'sp ace', '.env.sp'), 'R5=x\n');
    writeFileSync(join(dir, 'allowed.txt'), 'fine\n');
    symlinkSync('.env.short', join(dir, 'link-short.txt'));
    (await api()).invalidateExcludedIndex();
  });

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'mp-tools-it-'));
    logFile = join(logDir, 'fake.jsonl');
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CLI_MODE = 'ok';
    delete process.env.FAKE_CLI_STRUCTURED;
    delete process.env.FAKE_CLI_STDIN_MARKERS;
    delete process.env.FAKE_CLI_TEXT;
  });

  afterEach(() => rmSync(logDir, { recursive: true, force: true }));

  after(async () => {
    const global = vscode.ConfigurationTarget.Global;
    for (const key of [
      'claude.path',
      'codex.path',
      'chat.claude.models',
      'chat.codex.models',
      'chat.toolCalling',
    ]) {
      await config().update(key, undefined, global);
    }
    rmSync(dir, { recursive: true, force: true });
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_MODE;
    delete process.env.FAKE_CLI_STRUCTURED;
    delete process.env.FAKE_CLI_STDIN_MARKERS;
  });

  it('declares tool calling only while the setting is on (AC1)', async () => {
    const declared = async (): Promise<unknown[]> =>
      (await (await api()).chatModelInfo())
        .filter((m) => m.id === CLAUDE || m.id === CODEX)
        .map((m) => m.capabilities.toolCalling);
    // Codex does not declare it: it called no tool in agent mode (docs/bench.md, P4T-REV-002).
    assert.deepEqual(await declared(), [true, false]);
    await config().update('chat.toolCalling', false, vscode.ConfigurationTarget.Global);
    try {
      assert.deepEqual(await declared(), [false, false]);
    } finally {
      await config().update('chat.toolCalling', true, vscode.ConfigurationTarget.Global);
    }
  });

  it('reports a Claude tool call as a tool call part; the CLI stays without tools (AC2)', async () => {
    process.env.FAKE_CLI_STRUCTURED = JSON.stringify({
      message: 'Reading it.',
      tool_calls: [{ name: 'read_file', arguments: '{"path":"README.md"}' }],
    });
    process.env.FAKE_CLI_STDIN_MARKERS = '## read_file,Reads a file of the workspace.';
    const parts = await send(CLAUDE, [vscode.LanguageModelChatMessage.User('read the readme')], {
      tools: [READ],
    });
    assert.equal(parts.length, 2);
    assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);
    assert.equal(parts[0].value, 'Reading it.');
    const call = parts[1];
    assert.ok(call instanceof vscode.LanguageModelToolCallPart);
    assert.equal(call.name, 'read_file');
    assert.deepEqual(call.input, { path: 'README.md' });
    assert.match(call.callId, /^call_[0-9a-f]{24}$/);
    const entry = answered();
    assert.ok(entry.args.includes('--json-schema'));
    assert.equal(entry.args[entry.args.indexOf('--tools') + 1], '');
    assert.ok(entry.args.includes('--safe-mode'));
    assert.deepEqual(entry.stdinMarkers, {
      '## read_file': true,
      'Reads a file of the workspace.': true,
    });
    const record = (await api()).chatRecords().at(-1)!;
    assert.equal(record.tools, 1);
    assert.equal(record.toolCalls, 1);
    assert.equal(record.outcome, 'complete');
  });

  it('answers a Codex request with tools in text: Codex declares no tool calling (P4T-REV-002)', async () => {
    process.env.FAKE_CLI_TEXT = 'codex plain answer';
    const parts = await send(CODEX, [vscode.LanguageModelChatMessage.User('find add')], {
      tools: [READ, SEARCH],
    });
    assert.ok(parts.every((part) => part instanceof vscode.LanguageModelTextPart));
    assert.ok(!answered().args.includes('--output-schema'));
  });

  it('answers in text when the model calls no tool', async () => {
    process.env.FAKE_CLI_STRUCTURED = JSON.stringify({
      message: 'No tool needed.',
      tool_calls: [],
    });
    const parts = await send(CLAUDE, [vscode.LanguageModelChatMessage.User('hi')], {
      tools: [READ],
    });
    assert.equal(parts.length, 1);
    assert.ok(parts[0] instanceof vscode.LanguageModelTextPart);
    assert.equal(parts[0].value, 'No tool needed.');
  });

  for (const [label, structured] of [
    ['an unknown tool', { message: 'x', tool_calls: [{ name: 'rm_rf', arguments: '{}' }] }],
    [
      'arguments that are not an object',
      { message: 'x', tool_calls: [{ name: 'read_file', arguments: '[1]' }] },
    ],
    ['an answer that is not the envelope', 'just text'],
  ] as const) {
    it(`fails without parts on ${label} (AC3)`, async () => {
      process.env.FAKE_CLI_STRUCTURED =
        typeof structured === 'string' ? structured : JSON.stringify(structured);
      const parts: unknown[] = [];
      await assert.rejects(async () => {
        for (const part of await send(CLAUDE, [vscode.LanguageModelChatMessage.User('go')], {
          tools: [READ],
        })) {
          parts.push(part);
        }
      }, /unusable tool-call answer/);
      assert.equal(parts.length, 0);
      assert.equal((await api()).chatRecords().at(-1)!.outcome, 'error');
    });
  }

  it('fails a Required request that makes no call (AC3)', async () => {
    process.env.FAKE_CLI_STRUCTURED = JSON.stringify({ message: 'no', tool_calls: [] });
    process.env.FAKE_CLI_STDIN_MARKERS = 'You must call at least one tool';
    await assert.rejects(
      send(CLAUDE, [vscode.LanguageModelChatMessage.User('go')], {
        tools: [READ],
        toolMode: vscode.LanguageModelChatToolMode.Required,
      }),
      /required a tool call/,
    );
    assert.deepEqual(answered().stdinMarkers, { 'You must call at least one tool': true });
  });

  const excludedCases: [string, () => string, string][] = [
    ['an absolute path', () => join(dir, '.env.short'), 'Q7=z'],
    ['a relative path', () => 'tooltest/.env.short', 'Q7=z'],
    ['an encoded file URI', () => pathToFileURL(join(dir, 'sp ace', '.env.sp')).href, 'R5=x'],
    ['a relative symlink alias', () => 'tooltest/link-short.txt', 'W8=y'],
    ['a command line', () => 'head -n 2 tooltest/link-short.txt', 'W8=y'],
    ['a quoted command word', () => "cat tooltest/'.e'nv.short", 'Q7=z'],
    // Only the content net's list of excluded files resolves this one.
    ['a wildcard glob value', () => 'tooltest/.e?v.short', 'Q7=z'],
  ];
  for (const [label, path, mark] of excludedCases) {
    it(`never sends the result of a read of an excluded file by ${label} (AC4)`, async () => {
      process.env.FAKE_CLI_STDIN_MARKERS = `${mark},[content excluded by magipilot.exclude]`;
      await send(CLAUDE, readConversation(path(), `${mark}\nQ7=z\nW8=y\nR5=x`), { tools: [READ] });
      assert.deepEqual(answered().stdinMarkers, {
        [mark]: false,
        '[content excluded by magipilot.exclude]': true,
      });
    });
  }

  const keptCases: [string, () => vscode.LanguageModelChatMessage[]][] = [
    [
      'a search query',
      () => [
        vscode.LanguageModelChatMessage.User('find it'),
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart('call_s', 'search', {
            query: 'export function add',
          }),
        ]),
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart('call_s', [
            new vscode.LanguageModelTextPart('KEPT_MARK in src/a.ts'),
          ]),
        ]),
      ],
    ],
    ['an allowed relative path', () => readConversation('tooltest/allowed.txt', 'KEPT_MARK')],
    ['an absent absolute path', () => readConversation(join(dir, 'absent.txt'), 'KEPT_MARK')],
  ];
  for (const [label, messages] of keptCases) {
    it(`keeps the result of ${label} (AC4, P4T-R003)`, async () => {
      process.env.FAKE_CLI_STDIN_MARKERS = 'KEPT_MARK';
      await send(CLAUDE, messages(), { tools: [READ, SEARCH] });
      assert.deepEqual(answered().stdinMarkers, { KEPT_MARK: true });
    });
  }

  for (const fault of ['indexFails', 'unstable'] as const) {
    it(`replaces every tool part when the exclusion index is unusable: ${fault} (phase-4-hardening AC5)`, async () => {
      const testApi = await api();
      testApi.setExclusionFaults({ [fault]: true });
      try {
        process.env.FAKE_CLI_STDIN_MARKERS = 'KEPT_MARK,[content excluded by magipilot.exclude]';
        await send(CLAUDE, readConversation('tooltest/allowed.txt', 'KEPT_MARK'), {
          tools: [READ],
        });
        assert.deepEqual(answered().stdinMarkers, {
          KEPT_MARK: false,
          '[content excluded by magipilot.exclude]': true,
        });
      } finally {
        testApi.setExclusionFaults({});
      }
    });
  }

  /** A terminal conversation: one `run_in_terminal` call per command, each answered with `result`. */
  function terminalConversation(
    commands: string[],
    result: string,
  ): vscode.LanguageModelChatMessage[] {
    const messages = [vscode.LanguageModelChatMessage.User('look around')];
    commands.forEach((command, i) => {
      messages.push(
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart(`call_c${i}`, 'run_in_terminal', { command }),
        ]),
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart(`call_c${i}`, [
            new vscode.LanguageModelTextPart(i === commands.length - 1 ? result : 'ok'),
          ]),
        ]),
      );
    });
    return messages;
  }

  const TERMINAL: vscode.LanguageModelChatTool = {
    name: 'run_in_terminal',
    description: 'Runs a command in a terminal.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
  };

  const folderCases: [string, string[]][] = [
    ['a cd in the same command line', ['cd tooltest && cat link-short.txt']],
    ['a cd in an earlier call', ['cd tooltest', 'cat link-short.txt']],
  ];
  for (const [label, commands] of folderCases) {
    it(`follows ${label} to a symlink alias (phase-4-hardening AC6 b)`, async () => {
      process.env.FAKE_CLI_STDIN_MARKERS = 'W8=y,[content excluded by magipilot.exclude]';
      await send(CLAUDE, terminalConversation(commands, 'W8=y'), { tools: [TERMINAL] });
      assert.deepEqual(answered().stdinMarkers, {
        'W8=y': false,
        '[content excluded by magipilot.exclude]': true,
      });
    });
  }

  it('keeps the result of a terminal command that names no excluded file (phase-4-hardening AC6)', async () => {
    process.env.FAKE_CLI_STDIN_MARKERS = 'KEPT_MARK';
    await send(CLAUDE, terminalConversation(['cd tooltest', 'cat allowed.txt'], 'KEPT_MARK'), {
      tools: [TERMINAL],
    });
    assert.deepEqual(answered().stdinMarkers, { KEPT_MARK: true });
  });

  it('nets an earlier edit call that quotes an excluded line (inspection P4T-I001)', async () => {
    // `.env` of the test workspace holds this line (.vscode-test.mjs); the call edits another file.
    process.env.FAKE_CLI_STDIN_MARKERS = 'not-a-real-secret-0001,KEEP_EDIT_MARK';
    await send(
      CLAUDE,
      [
        vscode.LanguageModelChatMessage.User('fix notes'),
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart('call_e', 'replace_string_in_file', {
            filePath: 'notes.txt',
            oldString: 'API_KEY=not-a-real-secret-0001\nKEEP_EDIT_MARK',
            newString: 'x',
          }),
        ]),
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart('call_e', [
            new vscode.LanguageModelTextPart('ok'),
          ]),
        ]),
      ],
      { tools: [READ] },
    );
    assert.deepEqual(answered().stdinMarkers, {
      'not-a-real-secret-0001': false,
      KEEP_EDIT_MARK: true,
    });
  });

  it("removes a search's prefixed line of an excluded file from a terminal result", async () => {
    // Not a recursive search: that one is replaced as a whole (D6, phase-4-hardening-review.md);
    // here the content net must remove the prefixed line and keep the other one.
    process.env.FAKE_CLI_STDIN_MARKERS = 'not-a-real-secret-0001,src/b.ts:2';
    await send(
      CLAUDE,
      [
        vscode.LanguageModelChatMessage.User('search'),
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart('call_g', 'run_in_terminal', {
            command: 'grep -n API src/b.ts notes.txt',
          }),
        ]),
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart('call_g', [
            new vscode.LanguageModelTextPart(
              './.env:1:API_KEY=not-a-real-secret-0001\nsrc/b.ts:2:  return a * b;',
            ),
          ]),
        ]),
      ],
      { tools: [READ] },
    );
    assert.deepEqual(answered().stdinMarkers, {
      'not-a-real-secret-0001': false,
      'src/b.ts:2': true,
    });
  });

  it('drops the result of a recursive command over a folder with an excluded file', async () => {
    process.env.FAKE_CLI_STDIN_MARKERS = 'RECURSIVE_MARK';
    await send(
      CLAUDE,
      [
        vscode.LanguageModelChatMessage.User('search'),
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart('call_r', 'run_in_terminal', {
            command: 'grep -rn KEY .',
          }),
        ]),
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart('call_r', [
            new vscode.LanguageModelTextPart('x:1:RECURSIVE_MARK'),
          ]),
        ]),
      ],
      { tools: [READ] },
    );
    assert.deepEqual(answered().stdinMarkers, { RECURSIVE_MARK: false });
  });

  it('keeps an earlier edit of an allowed file whose code has wildcards and braces', async () => {
    process.env.FAKE_CLI_STDIN_MARKERS = 'CODE_EDIT_MARK,EDIT_RESULT_MARK';
    const code = Array.from(
      { length: 30 },
      (_, i) => `const {a${i}, b${i}} = f({x, y}); const p${i} = a * b ? c[0] : d?.e ?? '*';`,
    ).join('\n');
    await send(
      CLAUDE,
      [
        vscode.LanguageModelChatMessage.User('refactor'),
        vscode.LanguageModelChatMessage.Assistant([
          new vscode.LanguageModelToolCallPart('call_c', 'replace_string_in_file', {
            filePath: 'tooltest/allowed.txt',
            oldString: 'fine',
            newString: `// CODE_EDIT_MARK\n${code}`,
          }),
        ]),
        vscode.LanguageModelChatMessage.User([
          new vscode.LanguageModelToolResultPart('call_c', [
            new vscode.LanguageModelTextPart('EDIT_RESULT_MARK'),
          ]),
        ]),
      ],
      { tools: [READ] },
    );
    assert.deepEqual(answered().stdinMarkers, { CODE_EDIT_MARK: true, EDIT_RESULT_MARK: true });
  });

  it('fails a tool-mode prompt that certainly cannot fit before the CLI is called (AC12)', async () => {
    const huge: vscode.LanguageModelChatTool = { ...READ, description: 'd'.repeat(2_000_000) };
    await assert.rejects(
      send(CLAUDE, [vscode.LanguageModelChatMessage.User('go')], { tools: [huge] }),
      /too large for this model/,
    );
    assert.equal(requests().length, 0);
  });

  it('counts tool results in full (AC12)', async () => {
    const model = await modelById(CLAUDE);
    const big = 'x'.repeat(20_000);
    const message = vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelToolResultPart('call_c', [new vscode.LanguageModelTextPart(big)]),
    ]);
    assert.ok((await model.countTokens(message)) > 20_000);
  });

  it('handles a request with tools as Ask mode while the setting is off (AC1)', async () => {
    await config().update('chat.toolCalling', false, vscode.ConfigurationTarget.Global);
    try {
      process.env.FAKE_CLI_TEXT = 'plain answer';
      const parts = await send(CLAUDE, [vscode.LanguageModelChatMessage.User('hi')], {
        tools: [READ],
      });
      assert.ok(parts.every((part) => part instanceof vscode.LanguageModelTextPart));
      assert.equal(parts.map((part) => part.value).join(''), 'plain answer');
      assert.ok(!answered().args.includes('--json-schema'));
    } finally {
      await config().update('chat.toolCalling', true, vscode.ConfigurationTarget.Global);
    }
  });
});
