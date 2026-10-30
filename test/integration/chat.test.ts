// P5 (docs/plans/phase-2.md): the chat provider inside VS Code, with the fake CLI as both
// `claude` and `codex`. Requests go through the public LM API, exactly as Copilot Chat calls it.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { failureMessage } from '../../src/core/backends/failures';
import { CHAT_PREAMBLE } from '../../src/features/chat/messages';
import type { TestApi } from '../../src/extension';

const FAKE = resolve(__dirname, '../../../test/fixtures/fake-cli/fake-cli.mjs');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeEntry {
  pid: number;
  args: string[];
  stdinMarkers?: Record<string, boolean>;
  answered?: boolean;
  hung?: boolean;
  version?: boolean;
  windowAsked?: string;
  event?: string;
  userMessage?: boolean;
}

/** The model information fields VS Code 1.144 reads beside the stable ones. */
type Info = vscode.LanguageModelChatInformation & { maxContextWindowTokens?: number };

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('magipilot');
}

/** Both vendors' models: one vendor per CLI (phase-4-context.md G1). */
async function models(): Promise<vscode.LanguageModelChat[]> {
  return [
    ...(await vscode.lm.selectChatModels({ vendor: 'magipilot' })),
    ...(await vscode.lm.selectChatModels({ vendor: 'magipilot-codex' })),
  ];
}

async function modelById(id: string): Promise<vscode.LanguageModelChat> {
  for (let i = 0; i < 50; i++) {
    const found = (await models()).find((m) => m.id === id);
    if (found) return found;
    await sleep(100);
  }
  throw new Error(`model ${id} did not appear`);
}

async function collect(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token = new vscode.CancellationTokenSource().token,
): Promise<string[]> {
  const response = await model.sendRequest(messages, {}, token);
  const parts: string[] = [];
  for await (const part of response.text) parts.push(part);
  return parts;
}

describe('Magipilot chat provider (fake CLI)', () => {
  let logDir: string;
  let logFile: string;

  const entries = (): FakeEntry[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeEntry)
      : [];
  const requests = (): FakeEntry[] => entries().filter((e) => !e.version);

  before(async () => {
    const global = vscode.ConfigurationTarget.Global;
    await config().update('claude.path', FAKE, global);
    await config().update('codex.path', FAKE, global);
    await config().update('chat.claude.models', ['fake-a', 'fake-b'], global);
    await config().update('chat.codex.models', ['fake-c'], global);
  });

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'mp-chat-it-'));
    logFile = join(logDir, 'fake.jsonl');
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CLI_MODE = 'ok';
    delete process.env.FAKE_CLI_TEXT;
    delete process.env.FAKE_CLI_STDIN_MARKERS;
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

  it('shows Claude (CLI) and Codex (CLI) models from the settings', async () => {
    await modelById('codex-cli.fake-c');
    const ids = (await models()).map((m) => m.id);
    for (const id of ['claude-cli.fake-a', 'claude-cli.fake-b', 'codex-cli.fake-c']) {
      assert.ok(ids.includes(id), `${id} missing from ${ids.join(', ')}`);
    }
    const model = await modelById('claude-cli.fake-a');
    // A configured id without discovery is named by its id.
    assert.equal(model.name, 'fake-a');
    assert.equal(model.maxInputTokens, 162_000);
  });

  it('streams a Claude answer in several parts', async () => {
    process.env.FAKE_CLI_TEXT = 'hello streaming world';
    const parts = await collect(await modelById('claude-cli.fake-a'), [
      vscode.LanguageModelChatMessage.User('hi'),
    ]);
    assert.ok(parts.length > 1, `expected several parts, got ${parts.length}`);
    assert.equal(parts.join(''), 'hello streaming world');
  });

  it('sends a multi-turn conversation as a transcript over stdin', async () => {
    process.env.FAKE_CLI_STDIN_MARKERS = '<turn role="assistant">,Reply to the last user turn.';
    await collect(await modelById('claude-cli.fake-a'), [
      vscode.LanguageModelChatMessage.User('one'),
      vscode.LanguageModelChatMessage.Assistant('two'),
      vscode.LanguageModelChatMessage.User('three'),
    ]);
    const entry = requests().find((e) => e.answered)!;
    assert.deepEqual(entry.stdinMarkers, {
      '<turn role="assistant">': true,
      'Reply to the last user turn.': true,
    });
  });

  it('switches between a Claude and a Codex model', async () => {
    process.env.FAKE_CLI_TEXT = 'from fake';
    assert.equal(
      (
        await collect(await modelById('claude-cli.fake-b'), [
          vscode.LanguageModelChatMessage.User('a'),
        ])
      ).join(''),
      'from fake',
    );
    assert.equal(
      (
        await collect(await modelById('codex-cli.fake-c'), [
          vscode.LanguageModelChatMessage.User('b'),
        ])
      ).join(''),
      'from fake',
    );
    const kinds = requests()
      .filter((e) => e.answered)
      .map((e) => (e.args[0] === 'exec' ? 'codex' : 'claude'));
    assert.deepEqual(kinds, ['claude', 'codex']);
  });

  it('cancellation ends the stream and kills the CLI process', async () => {
    process.env.FAKE_CLI_MODE = 'hang';
    const source = new vscode.CancellationTokenSource();
    const pending = collect(
      await modelById('claude-cli.fake-a'),
      [vscode.LanguageModelChatMessage.User('slow')],
      source.token,
    ).catch(() => []);
    let hung: FakeEntry | undefined;
    for (let i = 0; i < 50 && !hung; i++) {
      await sleep(100);
      hung = requests().find((e) => e.hung || e.answered === false);
    }
    assert.ok(hung, 'the fake CLI never received the request');
    source.cancel();
    await pending;
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      await sleep(100);
      try {
        process.kill(hung.pid, 0);
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, 'the fake CLI survived the cancellation');
  });

  it('never sends an excluded attachment to the CLI; attachments before it go through (AGENTS rule 6)', async () => {
    process.env.FAKE_CLI_STDIN_MARKERS = 'ENV_SECRET_MARK,KEEP_MARK';
    // Real files of the test workspace: attachment paths that name no file count as excluded.
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    const attachments = [
      '<attachments>',
      '<attachment id="a.ts">',
      `// filepath: ${root}/src/a.ts`,
      'export const a = 1; // KEEP_MARK',
      '</attachment>',
      '<attachment id=".env">',
      `// filepath: ${root}/.env`,
      'API_KEY=ENV_SECRET_MARK',
      '</attachment>',
      '</attachments>',
      '<prompt>',
      'explain',
      '</prompt>',
    ].join('\n');
    await collect(await modelById('claude-cli.fake-a'), [
      vscode.LanguageModelChatMessage.User(attachments),
    ]);
    const entry = requests().find((e) => e.answered)!;
    assert.deepEqual(entry.stdinMarkers, { ENV_SECRET_MARK: false, KEEP_MARK: true });
  });

  it('an attachment whose path was cut short by an odd file name counts as excluded (P2-I011)', async () => {
    process.env.FAKE_CLI_STDIN_MARKERS = 'ODD_NAME_SECRET_MARK,ODD_KEEP_MARK';
    const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
    // A file named `key">` + line break + `prod.pem`, serialised without escaping.
    const text = [
      '<attachment id="b.ts">',
      `// filepath: ${root}/src/b.ts`,
      'ODD_KEEP_MARK',
      '</attachment>',
      '<attachment id="key">',
      'prod.pem">',
      `// filepath: ${root}/key">`,
      'prod.pem',
      'ODD_NAME_SECRET_MARK',
      '</attachment>',
    ].join('\n');
    await collect(await modelById('claude-cli.fake-a'), [
      vscode.LanguageModelChatMessage.User(text),
    ]);
    const entry = requests().find((e) => e.answered)!;
    assert.deepEqual(entry.stdinMarkers, { ODD_NAME_SECRET_MARK: false, ODD_KEEP_MARK: true });
  });

  it('matches a staged diff in a nested repository against workspace-relative patterns (P2-I009)', async () => {
    const folder = vscode.workspace.workspaceFolders![0]!.uri;
    const nested = vscode.Uri.joinPath(folder, 'nested-repo');
    mkdirSync(nested.fsPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: nested.fsPath });
    const git = await vscode.extensions
      .getExtension<{
        getAPI(v: 1): { openRepository(root: vscode.Uri): Promise<unknown> };
      }>('vscode.git')!
      .activate();
    await git.getAPI(1).openRepository(nested);
    const global = vscode.ConfigurationTarget.Global;
    await config().update('exclude', ['nested-repo/private/**'], global);
    try {
      process.env.FAKE_CLI_STDIN_MARKERS = 'NESTED_SECRET_MARK,NESTED_KEEP_MARK';
      const diff = (path: string, line: string): string =>
        `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${line}`;
      const request = [
        '# CODE CHANGES:',
        '```diff',
        diff('private/key.txt', 'NESTED_SECRET_MARK'),
        diff('src/ok.ts', 'NESTED_KEEP_MARK'),
        '```',
      ].join('\n');
      await collect(await modelById('claude-cli.fake-a'), [
        vscode.LanguageModelChatMessage.User(request),
      ]);
      const entry = requests().find((e) => e.answered)!;
      assert.deepEqual(entry.stdinMarkers, { NESTED_SECRET_MARK: false, NESTED_KEEP_MARK: true });
    } finally {
      await config().update('exclude', undefined, global);
      rmSync(nested.fsPath, { recursive: true, force: true });
    }
  });

  it('a 300 KiB message goes through stdin; the CLI argument stays the fixed preamble (P2-R002)', async () => {
    const big = `BIG_MARK${'x'.repeat(300 * 1024)}`;
    process.env.FAKE_CLI_STDIN_MARKERS = 'BIG_MARK';
    // A System (role 3) message needs the proposed API `languageModelSystem`, which only Copilot
    // may use; the role-3 mapping is unit-tested and exercised by the real Copilot path (P8).
    // Here the large text travels as a user message: the transport (stdin) is the same.
    await collect(await modelById('claude-cli.fake-a'), [
      vscode.LanguageModelChatMessage.User(big),
      vscode.LanguageModelChatMessage.Assistant('a'),
      vscode.LanguageModelChatMessage.User('q'),
    ]);
    const entry = requests().find((e) => e.answered)!;
    assert.equal(entry.stdinMarkers?.BIG_MARK, true);
    const args = entry.args;
    assert.equal(args[args.indexOf('--system-prompt') + 1], CHAT_PREAMBLE);
  });

  it('routes commit messages and reports a workspace override (D2, P2-R003)', async () => {
    const chat = vscode.workspace.getConfiguration('chat');
    try {
      const ok = await vscode.commands.executeCommand<{ effective: boolean; overrides: string[] }>(
        'magipilot.useForCommitMessages',
        'claude-cli.fake-a',
      );
      assert.equal(ok.effective, true);
      assert.equal(chat.inspect('utilitySmallModel')?.globalValue, 'magipilot/claude-cli.fake-a');
      assert.equal(chat.inspect('utilityModel')?.globalValue, 'magipilot/claude-cli.fake-a');

      await chat.update('utilitySmallModel', 'copilot/other', vscode.ConfigurationTarget.Workspace);
      const overridden = await vscode.commands.executeCommand<{
        effective: boolean;
        overrides: string[];
      }>('magipilot.useForCommitMessages', 'claude-cli.fake-a');
      assert.equal(overridden.effective, false);
      assert.deepEqual(overridden.overrides, ['chat.utilitySmallModel (Workspace)']);
    } finally {
      await chat.update('utilitySmallModel', undefined, vscode.ConfigurationTarget.Workspace);
      await chat.update('utilitySmallModel', undefined, vscode.ConfigurationTarget.Global);
      await chat.update('utilityModel', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  for (const [mode, kind] of [
    ['auth', 'not-logged-in'],
    ['limit', 'limit'],
    ['context', 'context'],
  ] as const) {
    it(`a ${mode} failure reaches Copilot Chat with its fixed message (phase-3-errors AC5)`, async () => {
      process.env.FAKE_CLI_MODE = mode;
      for (const [id, cli] of [
        ['claude-cli.fake-a', 'claude'],
        ['codex-cli.fake-c', 'codex'],
      ] as const) {
        const model = await modelById(id);
        await assert.rejects(
          collect(model, [vscode.LanguageModelChatMessage.User('hi')]),
          (err: Error) => {
            assert.ok(
              err.message.includes(failureMessage(cli, kind)),
              `${id}: unexpected message: ${err.message}`,
            );
            return true;
          },
        );
      }
    });
  }

  it('Show Stats counts chat requests per model by outcome (phase-3-metrics AC1)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    await vscode.commands.executeCommand('magipilot.resetStats');
    const model = await modelById('claude-cli.fake-a');
    process.env.FAKE_CLI_TEXT = 'answer-marker-k3';
    await collect(model, [vscode.LanguageModelChatMessage.User('prompt-marker-q7')]);
    process.env.FAKE_CLI_MODE = 'auth';
    await assert.rejects(collect(model, [vscode.LanguageModelChatMessage.User('hi')]));
    await vscode.commands.executeCommand('magipilot.showStats');
    try {
      const html = api.statsHtml();
      assert.ok(html, 'the panel is open');
      assert.ok(
        html.includes(
          '<th scope="row">claude-cli.fake-a</th><td>2</td><td>1</td><td>0</td><td>1</td>',
        ),
        html,
      );
      assert.ok(!html.includes('prompt-marker-q7') && !html.includes('answer-marker-k3'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    }
  });

  it('configured models of a CLI that is not found are reported (phase-3-errors AC5)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    const global = vscode.ConfigurationTarget.Global;
    await config().update('claude.path', join(tmpdir(), 'magipilot-no-such-claude'), global);
    try {
      for (let i = 0; i < 50 && !api.chatHiddenNotices().includes('claude:not-installed'); i++) {
        await models();
        await sleep(100);
      }
      assert.ok(api.chatHiddenNotices().includes('claude:not-installed'));
      // The CLI that is found keeps its models. The notice keys last for the whole session, so on
      // a machine without a real `codex` an earlier suite may already have added
      // `codex:not-installed`; the declared models, not the notice keys, show that Codex was found.
      const ids = await cliIdsWhen((found) => !found.some((id) => id.startsWith('claude-cli.')));
      assert.ok(
        ids.includes('codex-cli.fake-c'),
        JSON.stringify({ ids, notices: api.chatHiddenNotices() }),
      );
      assert.ok(!ids.some((id) => id.startsWith('claude-cli.')), ids.join(','));
    } finally {
      await config().update('claude.path', FAKE, global);
    }
  });

  /**
   * The CLI model ids the provider declares, once `pick` accepts them. Asked of the provider
   * itself: VS Code re-reads its own list on its own schedule after a change event.
   */
  async function cliIdsWhen(pick: (ids: string[]) => boolean): Promise<string[]> {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    let ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids = (await api.chatModelInfo()).map((m) => m.id).filter((id) => id.includes('-cli.'));
      if (pick(ids)) break;
      await sleep(100);
    }
    return ids;
  }

  /** Discovery on for one test, at workspace level (the test workspace turns it off). */
  async function withDiscovery(on: boolean, run: () => Promise<void>): Promise<void> {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    const workspace = vscode.ConfigurationTarget.Workspace;
    await config().update('chat.discoverModels', on, workspace);
    try {
      await api.clearDiscoveredModels();
      await api.clearWindows();
      await run();
    } finally {
      delete process.env.FAKE_CLI_MODELS;
      delete process.env.FAKE_CLI_WINDOWS;
      await config().update('chat.discoverModels', false, workspace);
      await api.clearDiscoveredModels();
      await api.clearWindows();
    }
  }

  it("takes Claude's shorter privacy list at once when that setting changes (phase-4-discovery-fix.md F2, P4DF-006)", async () => {
    process.env.FAKE_CLI_MODELS = '1';
    // The fake then answers like Claude Code: the three aliases with the privacy variable.
    process.env.FAKE_CLI_PRIVACY_LIST = '1';
    const global = vscode.ConfigurationTarget.Global;
    try {
      await config().update('claude.disableNonessentialTraffic', false, global);
      await withDiscovery(true, async () => {
        let ids = await cliIdsWhen((found) => found.includes('claude-cli.claude-opus-4-6'));
        assert.ok(ids.includes('claude-cli.claude-opus-4-6'), ids.join(', '));
        // Turning the privacy setting on shortens the list for real: no two-minute hold.
        await config().update('claude.disableNonessentialTraffic', true, global);
        ids = await cliIdsWhen((found) => !found.includes('claude-cli.claude-opus-4-6'));
        assert.ok(!ids.includes('claude-cli.claude-opus-4-6'), ids.join(', '));
        for (const id of ['claude-cli.opus', 'claude-cli.sonnet', 'claude-cli.haiku']) {
          assert.ok(ids.includes(id), `${id} missing from ${ids.join(', ')}`);
        }
      });
    } finally {
      delete process.env.FAKE_CLI_PRIVACY_LIST;
      await config().update('claude.disableNonessentialTraffic', undefined, global);
    }
  });

  it('shows the models the CLIs report, the lists added, names unchanged (phase-4-models M1)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    process.env.FAKE_CLI_MODELS = '1';
    // Sonnet's window as the fake reports it for an unknown model, so its read cannot race the
    // assertions below.
    process.env.FAKE_CLI_WINDOWS = JSON.stringify({ sonnet: 200_000 });
    await withDiscovery(true, async () => {
      const ids = await cliIdsWhen(
        (found) => found.includes('codex-cli.gpt-6-luna') && found.includes('claude-cli.sonnet'),
      );
      for (const id of [
        'claude-cli.opus',
        'claude-cli.sonnet',
        'claude-cli.haiku',
        'claude-cli.claude-opus-4-6',
        'codex-cli.gpt-6.1-sol',
        'codex-cli.gpt-6-luna',
        // The configured ids stay, added to the discovered ones.
        'claude-cli.fake-a',
        'codex-cli.fake-c',
      ]) {
        assert.ok(ids.includes(id), `${id} missing from ${ids.join(', ')}`);
      }
      // Claude's default and Codex's hidden models are not offered.
      assert.ok(!ids.includes('claude-cli.default'));
      assert.ok(!ids.includes('codex-cli.gpt-reserve'));
      const info = await api.chatModelInfo();
      const sonnet = info.find((m) => m.id === 'claude-cli.sonnet')!;
      // The CLI's own name (the user's choice), the size Copilot can use as detail
      // (phase-4-picker.md U6: 200K window − 6 000 kept for the CLI), the effort choice.
      assert.equal(sonnet.name, 'Sonnet 5.5');
      assert.equal(sonnet.detail, '194K');
      const extra = sonnet as unknown as {
        maxContextWindowTokens?: number;
        configurationSchema?: {
          properties: { reasoningEffort: { enum: string[]; default: string } };
        };
      };
      assert.equal(extra.maxContextWindowTokens, 194_000);
      assert.deepEqual(extra.configurationSchema?.properties.reasoningEffort.enum, [
        'auto',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
      const sol = info.find((m) => m.id === 'codex-cli.gpt-6.1-sol')! as unknown as {
        maxContextWindowTokens?: number;
      };
      assert.equal(sol.maxContextWindowTokens, 459_000);
      // No user message reached the Claude probe, and its environment followed the setting.
      const asked = entries().filter((e) => (e as { initialized?: boolean }).initialized);
      assert.ok(asked.length > 0);
      for (const e of asked) {
        assert.equal((e as { nonessential?: string | null }).nonessential, '1');
      }
    });
  });

  it('passes the effort of a discovered model to the CLI (phase-4-effort E2)', async () => {
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(true, async () => {
      await cliIdsWhen((found) => found.includes('codex-cli.gpt-6-luna'));
      // Codex: the model's default level from the catalog (medium for gpt-6-luna).
      await collect(await modelById('codex-cli.gpt-6-luna'), [
        vscode.LanguageModelChatMessage.User('hi'),
      ]);
      // Claude: Auto, so no --effort.
      await collect(await modelById('claude-cli.opus'), [
        vscode.LanguageModelChatMessage.User('hi'),
      ]);
      const asked = requests().filter((e) => !(e as { initialized?: boolean }).initialized);
      const codexArgs = asked.find((e) => e.args[0] === 'exec')!.args;
      assert.ok(codexArgs.includes('model_reasoning_effort="medium"'), codexArgs.join(' '));
      const claudeArgs = asked.find(
        (e) => e.args.includes('--model') && e.args.includes('opus'),
      )!.args;
      assert.ok(!claudeArgs.includes('--effort'), claudeArgs.join(' '));
    });
  });

  it('passes the chosen effort, switches it on one model, and ignores an unknown one (P4E-I001)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(true, async () => {
      await cliIdsWhen(
        (found) => found.includes('codex-cli.gpt-6-luna') && found.includes('claude-cli.opus'),
      );
      const argsOf = (): string[][] =>
        requests()
          // One line per answered request (a process also logs its stdin end).
          .filter((e) => (e as { answered?: boolean }).answered === true)
          .map((e) => e.args);
      const effortArg = (args: string[]): string | undefined => {
        const at = args.indexOf('--effort');
        return at >= 0 ? args[at + 1] : undefined;
      };
      await api.chatRequestWithConfiguration('claude-cli.opus', { reasoningEffort: 'max' }, 'hi');
      await api.chatRequestWithConfiguration('claude-cli.opus', { reasoningEffort: 'low' }, 'hi');
      // Not one of Claude's levels: the default (Auto), so no --effort.
      await api.chatRequestWithConfiguration('claude-cli.opus', { reasoningEffort: 'ultra' }, 'hi');
      await api.chatRequestWithConfiguration(
        'codex-cli.gpt-6-luna',
        { reasoningEffort: 'xhigh' },
        'hi',
      );
      // Not one of gpt-6-luna's levels: its default, medium.
      await api.chatRequestWithConfiguration(
        'codex-cli.gpt-6-luna',
        { reasoningEffort: 'ultra' },
        'hi',
      );
      const all = argsOf();
      const claude = all.filter((args) => args.includes('--model'));
      const codex = all.filter((args) => args[0] === 'exec');
      assert.deepEqual(claude.map(effortArg), ['max', 'low', undefined]);
      assert.ok(codex[0]!.includes('model_reasoning_effort="xhigh"'), codex[0]!.join(' '));
      assert.ok(codex[1]!.includes('model_reasoning_effort="medium"'), codex[1]!.join(' '));
    });
  });

  it('uses the chosen effort in a tool-mode turn too (P4E-I001)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    const global = vscode.ConfigurationTarget.Global;
    process.env.FAKE_CLI_MODELS = '1';
    await config().update('chat.toolCalling', true, global);
    try {
      await withDiscovery(true, async () => {
        await cliIdsWhen((found) => found.includes('claude-cli.opus'));
        await api.chatRequestWithConfiguration(
          'claude-cli.opus',
          { reasoningEffort: 'xhigh' },
          'hi',
          [{ name: 'read_file', description: 'Reads a file.', inputSchema: { type: 'object' } }],
        );
        const args = requests().find((e) => e.args.includes('--json-schema'))!.args;
        assert.equal(args[args.indexOf('--effort') + 1], 'xhigh');
      });
    } finally {
      await config().update('chat.toolCalling', undefined, global);
    }
  });

  it('registers each CLI under its own vendor, one picker tab each (phase-4-context.md G1)', async () => {
    await modelById('codex-cli.fake-c');
    const claude = (await vscode.lm.selectChatModels({ vendor: 'magipilot' })).map((m) => m.id);
    const codex = (await vscode.lm.selectChatModels({ vendor: 'magipilot-codex' })).map(
      (m) => m.id,
    );
    assert.ok(claude.includes('claude-cli.fake-a'), claude.join(', '));
    assert.ok(!claude.some((id) => id.startsWith('codex-cli.')), claude.join(', '));
    assert.deepEqual(codex, ['codex-cli.fake-c']);
    // A Codex request goes through the Codex vendor.
    process.env.FAKE_CLI_TEXT = 'codex answer';
    const [model] = await vscode.lm.selectChatModels({
      vendor: 'magipilot-codex',
      id: 'codex-cli.fake-c',
    });
    const parts = await collect(model!, [vscode.LanguageModelChatMessage.User('hi')]);
    assert.equal(parts.join(''), 'codex answer');
  });

  /** The provider's model information, once `pick` accepts it. */
  async function infoWhen(pick: (byId: Map<string, Info>) => boolean): Promise<Map<string, Info>> {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    let byId = new Map<string, Info>();
    for (let i = 0; i < 150; i++) {
      byId = new Map((await api.chatModelInfo()).map((m) => [m.id, m as Info]));
      if (pick(byId)) break;
      await sleep(100);
    }
    return byId;
  }

  it("shows each Claude model's own window, read in the background without a model call (W1–W4)", async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    const global = vscode.ConfigurationTarget.Global;
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(true, async () => {
      await api.clearWindows();
      const byId = await infoWhen(
        (found) =>
          found.get('claude-cli.opus')?.maxContextWindowTokens === 994_000 &&
          found.get('claude-cli.claude-opus-4-6')?.maxContextWindowTokens === 194_000,
      );
      const opus = byId.get('claude-cli.opus')!;
      // The size Copilot can use (phase-4-picker.md U6), from the 1M window.
      assert.equal(opus.maxContextWindowTokens, 994_000);
      assert.equal(opus.maxInputTokens, 962_000);
      assert.equal(opus.detail, '1M');
      const old = byId.get('claude-cli.claude-opus-4-6')!;
      assert.equal(old.maxInputTokens, 162_000);
      // Codex: the catalog window, 95 % usable.
      assert.equal(byId.get('codex-cli.gpt-6-luna')?.maxContextWindowTokens, 242_400);
      assert.equal(
        byId.get('codex-cli.gpt-6-luna')?.maxInputTokens,
        Math.floor(272_000 * 0.95) - 32_000,
      );
      // Each read started with --model and sent no user message.
      const asked = requests().filter((e) => e.windowAsked);
      assert.ok(asked.length >= 2, `reads: ${asked.length}`);
      for (const entry of asked)
        assert.deepEqual(entry.args.slice(0, 2), ['--model', entry.windowAsked]);
      const ends = requests().filter((e) => e.event === 'stdin-end' && e.args[0] === '--model');
      assert.ok(ends.length > 0 && ends.every((e) => e.userMessage === false));
      assert.ok(!requests().some((e) => e.args[0] === '--model' && e.answered));
      // The change event reached VS Code: its own model object shows the new budget.
      let seen = 0;
      for (let i = 0; i < 100 && seen !== 962_000; i++) {
        seen = (await modelById('claude-cli.opus')).maxInputTokens;
        if (seen !== 962_000) await sleep(100);
      }
      assert.equal(seen, 962_000);
      // A cap (W4): every window at most 300 000.
      await config().update('chat.contextWindowLimit', 300_000, global);
      try {
        const capped = await infoWhen(
          (found) => found.get('claude-cli.opus')?.maxContextWindowTokens === 294_000,
        );
        assert.equal(capped.get('claude-cli.opus')?.maxInputTokens, 262_000);
        assert.equal(capped.get('claude-cli.claude-opus-4-6')?.maxContextWindowTokens, 194_000);
        assert.equal(capped.get('codex-cli.gpt-6-luna')?.maxContextWindowTokens, 242_400);
      } finally {
        await config().update('chat.contextWindowLimit', undefined, global);
      }
    });
  });

  it('passes Codex its largest window only when the user opts in (W5)', async () => {
    const global = vscode.ConfigurationTarget.Global;
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(true, async () => {
      await cliIdsWhen((found) => found.includes('codex-cli.gpt-6-luna'));
      const lastCodexArgs = (): string[] =>
        requests()
          .filter((e) => e.args[0] === 'exec')
          .at(-1)!.args;
      await collect(await modelById('codex-cli.gpt-6-luna'), [
        vscode.LanguageModelChatMessage.User('hi'),
      ]);
      assert.ok(!lastCodexArgs().some((arg) => arg.startsWith('model_context_window')));
      await config().update('chat.codex.maxContextWindow', true, global);
      try {
        const byId = await infoWhen(
          (found) => found.get('codex-cli.gpt-6-luna')?.maxContextWindowTokens === 812_400,
        );
        assert.equal(byId.get('codex-cli.gpt-6-luna')?.detail, '812K');
        await collect(await modelById('codex-cli.gpt-6-luna'), [
          vscode.LanguageModelChatMessage.User('hi'),
        ]);
        const args = lastCodexArgs();
        assert.equal(args[args.indexOf('model_context_window=872000') - 1], '-c');
      } finally {
        await config().update('chat.codex.maxContextWindow', undefined, global);
      }
    });
  });

  it('refuses a request whose settings or model information change while it is prepared, and a stale budget (P4CTX-I002, P4PICK-I001, P4PICK-I003)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    const global = vscode.ConfigurationTarget.Global;
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(true, async () => {
      await config().update('chat.codex.maxContextWindow', true, global);
      try {
        await infoWhen(
          (found) => found.get('codex-cli.gpt-6-luna')?.maxContextWindowTokens === 812_400,
        );
        // VS Code must hold the 872K budget, so the requests below are prepared for it.
        const opted = Math.floor(872_000 * 0.95) - 32_000;
        let luna = await modelById('codex-cli.gpt-6-luna');
        for (let i = 0; i < 100 && luna.maxInputTokens !== opted; i++) {
          await sleep(100);
          luna = await modelById('codex-cli.gpt-6-luna');
        }
        assert.equal(luna.maxInputTokens, opted);
        const execCalls = (): FakeEntry[] => requests().filter((e) => e.args[0] === 'exec');
        // 1. A setting changes right after the index read, before VS Code reads the models
        //    again: the request is refused before any CLI starts (inspection P4PICK-I001).
        api.setExclusionFaults({ refreshAfterIndex: true });
        const before = execCalls().length;
        await assert.rejects(
          collect(luna, [vscode.LanguageModelChatMessage.User('hi')]),
          /chat settings changed while the request was prepared/,
        );
        assert.equal(execCalls().length, before);
        // 2. Codex's executable path changes while the request waits for the index: the request
        //    would mix the new executable with the old model, so it is refused as well.
        api.setExclusionFaults({ holdMs: 1_500 });
        const pending = collect(luna, [vscode.LanguageModelChatMessage.User('hi')]);
        await sleep(300);
        await config().update('codex.path', `${dirname(FAKE)}/./${basename(FAKE)}`, global);
        await assert.rejects(pending, /chat settings changed while the request was prepared/);
        assert.equal(execCalls().length, before);
        await config().update('codex.path', FAKE, global);
        // 2b. A CLI reports new model information meanwhile (a window read or a new list, no
        //     settings change): the budget may have shrunk, so the request is refused too
        //     (re-inspection P4PICK-I003).
        await infoWhen(
          (found) => found.get('codex-cli.gpt-6-luna')?.maxContextWindowTokens === 812_400,
        );
        const changing = collect(await modelById('codex-cli.gpt-6-luna'), [
          vscode.LanguageModelChatMessage.User('hi'),
        ]);
        await sleep(300);
        api.notifyModelsChanged();
        await assert.rejects(
          changing,
          /model's information changed while the request was prepared/,
        );
        assert.equal(execCalls().length, before);
        api.setExclusionFaults({});
        // Settled again, the request goes out with the window argument of its model.
        await infoWhen(
          (found) => found.get('codex-cli.gpt-6-luna')?.maxContextWindowTokens === 812_400,
        );
        await collect(await modelById('codex-cli.gpt-6-luna'), [
          vscode.LanguageModelChatMessage.User('hi'),
        ]);
        const sentArgs = execCalls().at(-1)!.args;
        assert.ok(sentArgs.includes('model_context_window=872000'), sentArgs.join(' '));
        await config().update('chat.contextWindowLimit', 300_000, global);
        // 3. A request trimmed for a larger budget than the model has now (a stale copy in VS
        //    Code) is refused before any CLI starts.
        await infoWhen(
          (found) => found.get('codex-cli.gpt-6-luna')?.maxContextWindowTokens === 269_000,
        );
        const sent = execCalls().length;
        await assert.rejects(
          api.chatRequestWithConfiguration('codex-cli.gpt-6-luna', {}, 'hi', undefined, {
            maxInputTokens: opted,
          }),
          /context size changed while the request was prepared/,
        );
        assert.equal(execCalls().length, sent);
      } finally {
        api.setExclusionFaults({});
        await config().update('codex.path', FAKE, global);
        await config().update('chat.contextWindowLimit', undefined, global);
        await config().update('chat.codex.maxContextWindow', undefined, global);
      }
    });
  });

  it('declares effort and context size as VS Code groups them; a context size changes no CLI argument (phase-4-picker.md U1–U3, phase-4-sizes.md S1, S4)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(true, async () => {
      const byId = await infoWhen((found) => found.has('codex-cli.gpt-6-luna'));
      const luna = byId.get('codex-cli.gpt-6-luna') as Info & {
        configurationSchema?: {
          properties: Record<string, { group?: string; readOnly?: boolean; enum?: unknown[] }>;
        };
      };
      const properties = luna.configurationSchema!.properties;
      assert.equal(properties.reasoningEffort?.group, 'navigation');
      // Under `contextTier`, which Copilot does not apply (phase-4-sizes.md D7): a tier, then the
      // full size, which is the default.
      assert.equal(properties.contextSize, undefined);
      assert.equal(properties.contextTier?.group, 'tokens');
      assert.equal(properties.contextTier?.readOnly, undefined);
      assert.deepEqual(properties.contextTier?.enum, [128_000, luna.maxContextWindowTokens]);
      const execArgs = (): string[][] =>
        requests()
          .filter((e) => e.args[0] === 'exec')
          .map((e) => e.args.filter((arg) => !arg.includes('magipilot-codex')));
      await api.chatRequestWithConfiguration(
        'codex-cli.gpt-6-luna',
        { reasoningEffort: 'high' },
        'hi',
      );
      await api.chatRequestWithConfiguration(
        'codex-cli.gpt-6-luna',
        { reasoningEffort: 'high', contextSize: luna.maxContextWindowTokens },
        'hi',
      );
      await api.chatRequestWithConfiguration(
        'codex-cli.gpt-6-luna',
        { reasoningEffort: 'high', contextTier: 128_000 },
        'hi',
      );
      const [without, withContext, withTier] = execArgs().slice(-3);
      assert.deepEqual(withContext, without);
      assert.deepEqual(withTier, without);
      assert.ok(without!.includes('model_reasoning_effort="high"'), without!.join(' '));
    });
  });

  it('moves an old Codex utility value to the Codex vendor and reports a workspace one (G2)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    const chat = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('chat');
    const global = vscode.ConfigurationTarget.Global;
    const workspace = vscode.ConfigurationTarget.Workspace;
    try {
      await chat().update('utilityModel', 'magipilot/codex-cli.fake-c', global);
      await chat().update('utilitySmallModel', 'magipilot/claude-cli.fake-a', global);
      await chat().update('utilitySmallModel', 'magipilot/codex-cli.fake-c', workspace);
      const result = await api.migrateUtilityModels();
      assert.deepEqual(result.rewritten, ['chat.utilityModel']);
      assert.deepEqual(result.reported, ['chat.utilitySmallModel (Workspace)']);
      assert.equal(chat().inspect('utilityModel')?.globalValue, 'magipilot-codex/codex-cli.fake-c');
      // Claude's identifiers did not change; a workspace value is never written.
      assert.equal(chat().inspect('utilitySmallModel')?.globalValue, 'magipilot/claude-cli.fake-a');
      assert.equal(
        chat().inspect('utilitySmallModel')?.workspaceValue,
        'magipilot/codex-cli.fake-c',
      );
      // The commit command writes each model's own vendor.
      await chat().update('utilitySmallModel', undefined, workspace);
      await vscode.commands.executeCommand('magipilot.useForCommitMessages', 'codex-cli.fake-c');
      assert.equal(
        chat().inspect('utilitySmallModel')?.globalValue,
        'magipilot-codex/codex-cli.fake-c',
      );
    } finally {
      await chat().update('utilitySmallModel', undefined, workspace);
      await chat().update('utilitySmallModel', undefined, global);
      await chat().update('utilityModel', undefined, global);
    }
  });

  it('with discovery off, only the lists, and no CLI is asked (phase-4-models M1)', async () => {
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(false, async () => {
      const ids = await cliIdsWhen((found) => !found.includes('claude-cli.sonnet'));
      assert.deepEqual(ids.sort(), ['claude-cli.fake-a', 'claude-cli.fake-b', 'codex-cli.fake-c']);
      assert.ok(!entries().some((e) => (e as { initialized?: boolean }).initialized));
      assert.ok(!entries().some((e) => (e as { catalog?: boolean }).catalog));
    });
  });

  it('keeps the last good list when a CLI stops answering (phase-4-models M4, M5)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    process.env.FAKE_CLI_MODELS = '1';
    await withDiscovery(true, async () => {
      await cliIdsWhen((found) => found.includes('claude-cli.sonnet'));
      // The CLI now answers with no models; a settings refresh asks it again.
      delete process.env.FAKE_CLI_MODELS;
      const global = vscode.ConfigurationTarget.Global;
      await config().update('codex.effort', 'medium', global);
      await config().update('codex.effort', undefined, global);
      await sleep(500);
      const ids = await cliIdsWhen((found) => found.includes('claude-cli.sonnet'));
      assert.ok(ids.includes('claude-cli.sonnet'), ids.join(', '));
      // The CLI was asked again and reported no models: the failure kind only.
      assert.ok(
        api
          .discoveryEvents()
          .some((e) => JSON.stringify(e) === JSON.stringify({ ...e, failure: 'no-models' })),
      );
    });
  });

  it('tells once per installation about a missing CLI that only discovery puts in play (P4M-I004)', async () => {
    const api = await vscode.extensions
      .getExtension<TestApi>('celalakcelikk.magipilot')!
      .activate();
    const global = vscode.ConfigurationTarget.Global;
    await config().update('chat.claude.models', [], global);
    await config().update('claude.path', join(logDir, 'no-such-claude'), global);
    try {
      await withDiscovery(true, async () => {
        await cliIdsWhen(() => api.discoveryNotices().length > 0);
        assert.deepEqual(api.discoveryNotices(), ['discovery:claude:not-installed']);
        // Remembered: asking again shows nothing new.
        await cliIdsWhen(() => false);
        assert.deepEqual(api.discoveryNotices(), ['discovery:claude:not-installed']);
      });
    } finally {
      await config().update('claude.path', FAKE, global);
      await config().update('chat.claude.models', ['fake-a', 'fake-b'], global);
    }
  });

  it('empty model settings show no CLI models', async () => {
    const global = vscode.ConfigurationTarget.Global;
    await config().update('chat.claude.models', [], global);
    await config().update('chat.codex.models', [], global);
    try {
      let ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        ids = (await models()).map((m) => m.id);
        if (!ids.some((id) => id.includes('-cli.'))) break;
        await sleep(100);
      }
      assert.deepEqual(
        ids.filter((id) => id.includes('-cli.')),
        [],
      );
    } finally {
      await config().update('chat.claude.models', ['fake-a', 'fake-b'], global);
      await config().update('chat.codex.models', ['fake-c'], global);
    }
  });
});
