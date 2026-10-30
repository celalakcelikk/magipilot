// npm run probe:chat — launches VS Code stable in an isolated profile (fresh user-data-dir and
// extensions-dir, so no GitHub session and no user extensions) with a synthetic git workspace,
// and runs test/probe/index.ts inside it. Results: .bench/probe-chat.json (+ the probe log).
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
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
const benchDir = join(root, '.bench');
mkdirSync(benchDir, { recursive: true });

const tempRoot = mkdtempSync(join(tmpdir(), 'magipilot-probe-'));
const workspace = join(tempRoot, 'workspace');
const userDataDir = join(tempRoot, 'user-data');
const extensionsDir = join(tempRoot, 'extensions');
const logPath = join(tempRoot, 'probe-log.jsonl');
const resultsPath = join(tempRoot, 'probe-results.json');

function git(...args) {
  execFileSync(
    'git',
    ['-c', 'user.name=Magipilot Probe', '-c', 'user.email=probe@example.invalid', ...args],
    { cwd: workspace, stdio: 'ignore' },
  );
}

function prepareWorkspace() {
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(
    join(workspace, 'src', 'probe.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
  );
  writeFileSync(join(workspace, 'src', 'change.txt'), 'initial\n');
  writeFileSync(join(workspace, 'README.md'), '# Magipilot probe workspace (synthetic)\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'chore: initial probe workspace');
}

function prepareProfile() {
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  mkdirSync(extensionsDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'User', 'settings.json'),
    `${JSON.stringify(
      {
        'workbench.startupEditor': 'none',
        'security.workspace.trust.enabled': false,
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
      },
      null,
      2,
    )}\n`,
  );
}

const benchResults = join(benchDir, 'probe-chat.json');
const benchLog = join(benchDir, 'probe-chat-log.jsonl');

async function main() {
  // Results of an earlier run must never be reported as this run's (review P0-I007).
  rmSync(benchResults, { force: true });
  rmSync(benchLog, { force: true });
  prepareWorkspace();
  prepareProfile();
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: 'stable',
    cachePath: join(root, '.vscode-test'),
  });
  let exitError;
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'out', 'test', 'probe', 'index.js'),
      launchArgs: [
        workspace,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        MAGIPILOT_PROBE_LOG: logPath,
        MAGIPILOT_PROBE_RESULTS: resultsPath,
      },
    });
  } catch (err) {
    exitError = err;
  }

  const produced = existsSync(resultsPath);
  if (produced) copyFileSync(resultsPath, benchResults);
  if (existsSync(logPath)) copyFileSync(logPath, benchLog);
  rmSync(tempRoot, { recursive: true, force: true });

  if (!produced) {
    console.error('probe produced no results in this run', exitError ?? '');
    process.exitCode = 1;
    return;
  }
  // FAIL lines are findings about VS Code, not failures of the probe itself.
  const { context, steps } = JSON.parse(readFileSync(benchResults, 'utf8'));
  console.log(JSON.stringify(context, null, 2));
  for (const s of steps) {
    console.log(
      `${s.id.padEnd(8)} ${s.passed ? 'PASS' : 'FAIL'}  ${s.description}${s.actionError ? `  [action error: ${s.actionError}]` : ''}${s.observations ? `  ${JSON.stringify(s.observations)}` : ''}`,
    );
  }
  if (exitError) {
    console.error(`VS Code test runner reported: ${exitError}`);
    process.exitCode = 1;
  }
}

await main();
