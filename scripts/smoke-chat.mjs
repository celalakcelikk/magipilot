// npm run smoke:chat (P8/P9, docs/plans/phase-2.md) — REAL Claude CLI (haiku) and Codex CLI
// (gpt-6-luna) through Copilot Chat in VS Code stable, isolated profile, no GitHub session.
// About 15–25 real CLI calls. Runs test/smoke-chat/index.ts; results in .bench/smoke-chat.json.
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
const tempRoot = mkdtempSync(join(tmpdir(), 'magipilot-smoke-chat-'));
const workspace = join(tempRoot, 'workspace');
const userDataDir = join(tempRoot, 'user-data');
const resultsPath = join(tempRoot, 'results.json');
const benchResults = join(root, '.bench', 'smoke-chat.json');

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
    {
      cwd: workspace,
      stdio: 'ignore',
    },
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
      extensionTestsPath: join(root, 'out', 'test', 'smoke-chat', 'index.js'),
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
        MAGIPILOT_CHAT_MARKERS: 'ORCHID-42',
        MAGIPILOT_SMOKE_CHAT_RESULTS: resultsPath,
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
  const benchLogs = join(root, '.bench', 'smoke-chat-logs');
  rmSync(benchLogs, { recursive: true, force: true });
  if (existsSync(join(userDataDir, 'logs'))) {
    cpSync(join(userDataDir, 'logs'), benchLogs, { recursive: true });
  }
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  const turns = inside?.turns ?? [];
  if (!inside) failures.push('no results from VS Code');
  if (inside && !inside.models?.includes('claude-cli.haiku'))
    failures.push('Claude (CLI) model missing');
  if (inside && !inside.models?.includes('codex-cli.gpt-6-luna'))
    failures.push('Codex (CLI) model missing');
  if (turns.length !== 10) failures.push(`expected 10 turns, got ${turns.length}`);
  if (turns.some((t) => t.outcome !== 'complete')) failures.push('a turn did not complete');
  if (turns.length > 1 && !(turns.at(-1).messages > turns[0].messages)) {
    failures.push('the history did not grow across the turns');
  }
  if (turns.length === 10 && turns[9].recalled !== true)
    failures.push('turn 10 did not recall the code word');
  if (
    inside?.switchToCodex?.modelId !== 'codex-cli.gpt-6-luna' ||
    inside?.switchToCodex?.outcome !== 'complete'
  ) {
    failures.push('the switch to Codex did not answer');
  }
  if (inside?.cancel?.outcome !== 'cancelled') failures.push('the UI cancel did not cancel');
  if (!(inside?.cancel?.parts >= 1))
    failures.push('the cancel came before the first streamed part');
  if (inside?.cancel?.claudeProcessesAfter !== 0)
    failures.push('a Claude CLI process survived the cancel');
  if (inside?.commit?.routing?.effective !== true) failures.push('commit routing not effective');
  if (
    inside?.commit?.providerRecord?.modelId !== 'claude-cli.haiku' ||
    inside?.commit?.providerRecord?.outcome !== 'complete'
  ) {
    failures.push('the commit message did not come from the Magipilot model');
  }
  if (!(inside?.commit?.scmInputLength > 0)) failures.push('the SCM input box stayed empty');
  if (after.claude > before.claude || after.codex > before.codex)
    failures.push('CLI processes left behind');
  if (runError) failures.push(`VS Code test runner: ${runError}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(failures.length === 0 ? 'smoke:chat PASS' : 'smoke:chat FAIL');
  if (failures.length > 0) process.exitCode = 1;
}

await main();
