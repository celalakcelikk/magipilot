// npm run smoke:agent (P8, docs/plans/phase-4-tools.md AC9a, AC10): REAL Claude CLI (haiku) in
// Copilot Chat's agent mode and inline chat (Codex declares no tool calling, docs/bench.md), with
// magipilot.chat.toolCalling on, in VS Code stable with an isolated profile. Copilot Chat runs its
// own read tool on a synthetic workspace. First it measures the agent-mode request size with the
// test-only echo model (no CLI call). At most 16 CLI calls (the test cancels beyond them). Runs
// test/smoke-agent/index.ts; results in .bench/smoke-agent.json.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'magipilot-smoke-agent-'));
const workspace = join(tempRoot, 'workspace');
const userDataDir = join(tempRoot, 'user-data');
const resultsPath = join(tempRoot, 'results.json');
const benchResults = join(root, '.bench', 'smoke-agent.json');
const MAX_CALLS = 16;

function count(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).split('\n').filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function git(...args) {
  execFileSync(
    'git',
    ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', ...args],
    { cwd: workspace, stdio: 'ignore' },
  );
}

function prepare() {
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(
    join(workspace, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: initial');
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    `${JSON.stringify(
      {
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
        'magipilot.chat.claude.models': ['haiku'],
        'magipilot.chat.codex.models': ['gpt-6-luna'],
        'magipilot.chat.toolCalling': true,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  rmSync(benchResults, { force: true });
  prepare();
  const before = { claude: count('claude -p --tools'), codex: count('codex exec --json') };
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: 'stable',
    cachePath: join(root, '.vscode-test'),
  });
  let runError;
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'out', 'test', 'smoke-agent', 'index.js'),
      launchArgs: [
        workspace,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${join(tempRoot, 'extensions')}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        MAGIPILOT_TEST: '1',
        MAGIPILOT_CHAT_MARKERS: 'ORCHID-42,add',
        MAGIPILOT_SMOKE_AGENT_RESULTS: resultsPath,
        MAGIPILOT_SMOKE_AGENT_MAX_CALLS: String(MAX_CALLS),
        // The provider refuses a CLI call beyond this before it starts (inspection P4T-I003).
        MAGIPILOT_TEST_MAX_CLI_CALLS: String(MAX_CALLS),
      },
    });
  } catch (err) {
    runError = err;
  }
  await new Promise((r) => setTimeout(r, 2000));
  const after = { claude: count('claude -p --tools'), codex: count('codex exec --json') };
  const inside = existsSync(resultsPath)
    ? JSON.parse(readFileSync(resultsPath, 'utf8'))
    : undefined;
  const summary = { before, after, inside, runError: runError ? String(runError) : undefined };
  mkdirSync(dirname(benchResults), { recursive: true });
  writeFileSync(benchResults, `${JSON.stringify(summary, null, 2)}\n`);
  // VS Code's own logs (Copilot Chat included) for diagnosis; the workspace content is synthetic.
  const benchLogs = join(root, '.bench', 'smoke-agent-logs');
  rmSync(benchLogs, { recursive: true, force: true });
  if (existsSync(join(userDataDir, 'logs'))) {
    cpSync(join(userDataDir, 'logs'), benchLogs, { recursive: true });
  }
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  if (!inside) failures.push('no results from VS Code');
  if (inside && inside.readyAfterMs === null) {
    // Nothing else ran: see the memory note on Copilot Chat's start-up in the test profile.
    failures.push('Copilot Chat never answered in agent mode (no request reached the echo model)');
  }
  if (inside && !(inside.echo?.tools > 0)) failures.push('no agent-mode request size measured');
  // Codex declares no tool calling (docs/bench.md), so the agent step runs for Claude only.
  for (const name of ['claude']) {
    const agent = inside?.agent?.[name];
    if (!agent) {
      failures.push(`${name}: agent mode not run`);
      continue;
    }
    if (!(agent.toolCallRequests >= 1)) failures.push(`${name}: no tool call reported`);
    if (agent.final?.outcome !== 'complete') failures.push(`${name}: no final answer`);
    if (agent.final?.markers?.['ORCHID-42'] !== true || agent.final?.markers?.add !== true) {
      failures.push(`${name}: the final answer lacks the marker or the function name`);
    }
  }
  const inline = inside?.inlineChat;
  if (!(inline?.tools >= 1)) failures.push('inline chat did not reach the provider with a tool');
  if (!(inline?.toolCalls >= 1)) failures.push('inline chat: the model made no tool call');
  if (typeof inside?.cliCalls === 'number' && inside.cliCalls > MAX_CALLS) {
    failures.push(`more than ${MAX_CALLS} CLI calls`);
  }
  if (after.claude > before.claude || after.codex > before.codex)
    failures.push('CLI processes left behind');
  if (runError) failures.push(`VS Code test runner: ${runError}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(failures.length === 0 ? 'smoke:agent PASS' : 'smoke:agent FAIL');
  if (failures.length > 0) process.exitCode = 1;
}

await main();
