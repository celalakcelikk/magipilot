// docs/plans/phase-4-sizes.md P3: the context size a user chooses (`contextTier`), through the
// provider with the fake CLI as both `claude` and `codex`.
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';

const FAKE = resolve(__dirname, '../../../test/fixtures/fake-cli/fake-cli.mjs');

interface FakeEntry {
  args: string[];
  answered?: boolean;
  version?: boolean;
  stdinChars?: number;
  stdinSha256?: string;
  stdinMarkers?: Record<string, boolean>;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('magipilot');
}

/** About 29 700 bytes, so six user turns pass a 128K tier but four fit in it. */
const PAD = 'lorem ipsum dolor sit amet '.repeat(1100);

/** `count` exchanges; user turn k starts with MARK-k, and the last one has no answer yet. */
function conversation(count: number): { role: 'user' | 'assistant'; text: string }[] {
  const turns: { role: 'user' | 'assistant'; text: string }[] = [];
  for (let k = 1; k <= count; k++) {
    turns.push({ role: 'user', text: `MARK-${k} ${PAD}` });
    if (k < count) turns.push({ role: 'assistant', text: `answer ${k}` });
  }
  return turns;
}

/** The CLI arguments without the per-run temporary directories. */
function stableArgs(args: readonly string[]): string[] {
  return args.map((arg) =>
    arg.startsWith(tmpdir()) || arg.includes('magipilot-') ? '<tmp>' : arg,
  );
}

describe('Magipilot chat context sizes (fake CLI)', () => {
  let api: TestApi;
  let logDir: string;
  let logFile: string;

  const entries = (): FakeEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeEntry)
      : [];
  const answered = (): FakeEntry[] => entries().filter((e) => !e.version && e.answered);

  before(async () => {
    api = (await vscode.extensions.getExtension<TestApi>('celalakcelikk.magipilot')!.activate())!;
    const global = vscode.ConfigurationTarget.Global;
    await config().update('claude.path', FAKE, global);
    await config().update('codex.path', FAKE, global);
    await config().update('chat.claude.models', ['fake-a'], global);
    await config().update('chat.codex.models', ['fake-c'], global);
  });

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'mp-sizes-it-'));
    logFile = join(logDir, 'fake.jsonl');
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CLI_MODE = 'ok';
    process.env.FAKE_CLI_STDIN_MARKERS = [1, 2, 3, 4, 5, 6].map((k) => `MARK-${k} `).join(',');
    delete process.env.FAKE_CLI_TEXT;
  });

  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  after(async () => {
    const global = vscode.ConfigurationTarget.Global;
    for (const key of ['claude.path', 'codex.path', 'chat.claude.models', 'chat.codex.models']) {
      await config().update(key, undefined, global);
    }
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_MODE;
    delete process.env.FAKE_CLI_STDIN_MARKERS;
  });

  /**
   * S0: what a six-exchange conversation sends today, recorded on the pre-build commit (31ae84a's
   * provider) with no configuration. Every request that does not choose a current tier must
   * send exactly this.
   */
  const BASELINE: Record<string, { args: string[]; stdinChars: number; stdinSha256: string }> = {
    'claude-cli.fake-a': {
      args: [
        '-p',
        '--tools',
        '',
        '--model',
        'fake-a',
        '--system-prompt',
        'You are a coding assistant answering inside VS Code (Copilot Chat). You have no tools and cannot read files: use only the text you are given. Answer in Markdown.',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--no-session-persistence',
        '--safe-mode',
        '--strict-mcp-config',
        '--setting-sources',
        '',
      ],
      stdinChars: 178_654,
      stdinSha256: '981118d97f59ce5460abb658ff4fcd6ec17a7db78edfcc2efae1936ef8d90f8c',
    },
    'codex-cli.fake-c': {
      args: [
        'exec',
        '--json',
        '--ephemeral',
        '-s',
        'read-only',
        '-m',
        'fake-c',
        '-c',
        'model_reasoning_effort="low"',
        '--skip-git-repo-check',
        '-C',
        '<tmp>',
        '--ignore-rules',
        '--ignore-user-config',
        '--disable',
        'plugins',
        '--disable',
        'apps',
        '--disable',
        'multi_agent',
        '--disable',
        'shell_tool',
        '--disable',
        'unified_exec',
        '--disable',
        'view_image',
        '--disable',
        'image_generation',
        '--disable',
        'browser_use',
        '--disable',
        'computer_use',
        '--disable',
        'memories',
        '-c',
        'skills.include_instructions=false',
        '-c',
        'include_permissions_instructions=false',
        '-c',
        'include_collaboration_mode_instructions=false',
        '-o',
        '<tmp>',
        '-',
      ],
      stdinChars: 178_817,
      stdinSha256: 'c548415b92514fff470120ee7fd90bb5a6427454d924be615e66dd44ef2ca7fe',
    },
  };

  /** Sends six exchanges with `configuration` and returns what the fake CLI received. */
  async function send(
    id: string,
    configuration: Record<string, unknown> | undefined,
  ): Promise<FakeEntry> {
    const before = answered().length;
    await api.chatConversation(id, configuration, conversation(6));
    const entry = answered()[before];
    assert.ok(entry, `no CLI request for ${id}`);
    return entry;
  }

  const facts = (entry: FakeEntry) => ({
    args: stableArgs(entry.args),
    stdinChars: entry.stdinChars,
    stdinSha256: entry.stdinSha256,
  });
  const last = () => api.chatRecords().at(-1)!;

  it('sends exactly what it sent before, by default (S0)', async () => {
    const full = { 'claude-cli.fake-a': 194_000, 'codex-cli.fake-c': 105_600 };
    for (const [id, expected] of Object.entries(BASELINE)) {
      // No choice; the full size; a size that is not a tier; and Copilot's own key, which
      // Magipilot never reads (phase-4-sizes.md S0, S2, D7).
      for (const configuration of [
        undefined,
        { contextTier: full[id as keyof typeof full] },
        { contextTier: 150_000 },
        { contextTier: 'long_context' },
        { contextSize: 128_000 },
      ]) {
        const entry = await send(id, configuration);
        assert.deepEqual(facts(entry), expected, `${id} ${JSON.stringify(configuration)}`);
        assert.equal(last().droppedMessages, 0);
        assert.equal(last().contextTier, undefined);
      }
    }
  });

  it('offers the tiers below the full size (S1)', async () => {
    const info = await api.chatModelInfo();
    const tier = (id: string) =>
      (
        info.find((m) => m.id === id) as {
          configurationSchema?: { properties: Record<string, { enum?: number[] }> };
        }
      ).configurationSchema?.properties;
    assert.deepEqual(tier('claude-cli.fake-a')?.contextTier?.enum, [128_000, 194_000]);
    assert.equal(tier('claude-cli.fake-a')?.contextSize, undefined);
    assert.deepEqual(tier('codex-cli.fake-c')?.contextTier?.enum, [105_600]);
  });

  it('leaves the oldest exchanges out to fit a chosen tier, and says so (S3, S5, S9)', async () => {
    const entry = await send('claude-cli.fake-a', { contextTier: 128_000 });
    assert.deepEqual(entry.stdinMarkers, {
      'MARK-1 ': false,
      'MARK-2 ': false,
      'MARK-3 ': true,
      'MARK-4 ': true,
      'MARK-5 ': true,
      'MARK-6 ': true,
    });
    assert.ok(entry.stdinChars! < 128_000, String(entry.stdinChars));
    assert.equal(last().contextTier, 128_000);
    assert.equal(last().droppedMessages, 4);
    assert.equal(last().overTier, undefined);
    assert.equal(api.lastChatNotice(), 'Magipilot: 4 older messages left out to fit 128K');
    // The CLI arguments do not change with a tier (S4).
    assert.deepEqual(stableArgs(entry.args), BASELINE['claude-cli.fake-a']!.args);
  });

  it('sends a message larger than the tier without the older ones (S3, D4)', async () => {
    const before = answered().length;
    await api.chatConversation('claude-cli.fake-a', { contextTier: 128_000 }, [
      { role: 'user', text: 'MARK-1 short' },
      { role: 'assistant', text: 'answer 1' },
      { role: 'user', text: `MARK-2 ${PAD.repeat(5)}` },
    ]);
    const entry = answered()[before]!;
    assert.equal(entry.stdinMarkers?.['MARK-1 '], false);
    assert.equal(entry.stdinMarkers?.['MARK-2 '], true);
    assert.equal(last().overTier, true);
    assert.equal(last().droppedMessages, 2);
    assert.equal(
      api.lastChatNotice(),
      'Magipilot: sent without the 2 older messages; this message alone is larger than 128K',
    );
  });

  it('keeps a tool call with its result when tool calling is on (S3, S4)', async () => {
    await config().update('chat.toolCalling', true, vscode.ConfigurationTarget.Global);
    try {
      const tools = [
        { name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object' } },
      ];
      const turns: Parameters<TestApi['chatConversation']>[2] = [
        { role: 'user', text: `MARK-1 ${PAD}` },
        { role: 'assistant', toolCall: { callId: 'c1', name: 'read_file', input: {} } },
        { role: 'user', toolResult: { callId: 'c1', text: `MARK-2 ${PAD}` } },
        { role: 'assistant', text: 'answer 1' },
        { role: 'user', text: `MARK-3 ${PAD}` },
        { role: 'assistant', text: 'answer 3' },
        { role: 'user', text: `MARK-4 ${PAD}` },
        { role: 'assistant', text: 'answer 4' },
        { role: 'user', text: `MARK-5 ${PAD}` },
      ];
      // Tool-calling models keep their tiers (D7).
      const info = await api.chatModelInfo();
      const schema = (
        info.find((m) => m.id === 'claude-cli.fake-a') as {
          configurationSchema?: { properties: Record<string, { enum?: number[] }> };
        }
      ).configurationSchema;
      assert.deepEqual(schema?.properties.contextTier?.enum, [128_000, 194_000]);
      // At the full size the tool result reaches the CLI.
      let before = answered().length;
      await api.chatConversation('claude-cli.fake-a', undefined, turns, tools);
      assert.equal(answered()[before]!.stdinMarkers?.['MARK-2 '], true);
      // With 128K, the first exchange leaves whole: the question, the call and its result.
      before = answered().length;
      await api.chatConversation('claude-cli.fake-a', { contextTier: 128_000 }, turns, tools);
      const markers = answered()[before]!.stdinMarkers!;
      assert.deepEqual(
        [1, 2, 3, 4, 5].map((k) => markers[`MARK-${k} `]),
        [false, false, true, true, true],
      );
      assert.equal(last().droppedMessages, 4);
      assert.equal(last().tools, 1);
    } finally {
      await config().update('chat.toolCalling', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
