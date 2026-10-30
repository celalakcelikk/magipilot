// npm run smoke:processes (P10, docs/plans/phase-1.md) — AGENTS rule 8: no CLI process may
// survive VS Code. Launches VS Code stable (isolated profile) with `magipilot.claude.path` set to
// the fake CLI, copied into a directory whose name is a unique marker, runs test/smoke/index.ts,
// lets VS Code close with a request in flight, then looks for any process carrying the marker.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
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
// --crash: the extension host SIGKILLs itself instead of shutting down (watchdog path, D13).
const crash = process.argv.includes('--crash');
// --real (P11, real quota: ~5 Claude calls): the real `claude` instead of the fake, counted by
// its command line; run manually after `node esbuild.mjs --tests`.
const real = process.argv.includes('--real');
// --ollama (Loop C, C-AC4): default settings (inline.backend = ollama) against the real local
// Ollama; checks one completion and that an excluded .env sends nothing. No CLI is involved.
const ollama = process.argv.includes('--ollama');
const marker = real ? 'claude -p --tools' : `mpsmoke${randomBytes(6).toString('hex')}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'magipilot-smoke-'));
const binDir = join(tempRoot, marker);
const fakeClaude = join(binDir, 'claude');
const workspace = join(tempRoot, 'workspace');
const userDataDir = join(tempRoot, 'user-data');
const extensionsDir = join(tempRoot, 'extensions');
const fakeLog = join(tempRoot, 'fake-cli.jsonl');
const modeFile = join(tempRoot, 'fake-mode');
const resultsPath = join(tempRoot, 'smoke-results.json');
const benchResults = join(
  root,
  '.bench',
  `smoke-processes${crash ? '-crash' : ''}${real ? '-real' : ''}${ollama ? '-ollama' : ''}.json`,
);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function alive() {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prepare() {
  mkdirSync(binDir, { recursive: true });
  copyFileSync(join(root, 'test', 'fixtures', 'fake-cli', 'fake-cli.mjs'), fakeClaude);
  chmodSync(fakeClaude, 0o755);
  writeFileSync(modeFile, 'ok');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(
    join(workspace, 'src', 'a.ts'),
    "import { mul } from './b';\n\nexport function add(a: number, b: number): number {\n  return \n}\n",
  );
  writeFileSync(join(workspace, '.env'), 'API_KEY=not-a-real-secret\n');
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
        // --ollama keeps every magipilot setting at its default (inline.backend = ollama).
        ...(ollama
          ? {}
          : {
              'magipilot.inline.backend': 'claude-cli',
              'magipilot.claude.path': real
                ? execFileSync('which', ['claude'], { encoding: 'utf8' }).trim()
                : fakeClaude,
              'magipilot.claude.warmPoolSize': real ? 1 : 2,
            }),
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  rmSync(benchResults, { force: true });
  prepare();
  const before = alive();
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: 'stable',
    cachePath: join(root, '.vscode-test'),
  });
  let runError;
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'out', 'test', 'smoke', 'index.js'),
      launchArgs: [
        workspace,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        MAGIPILOT_TEST: '1',
        MAGIPILOT_SMOKE_MARKER: marker,
        MAGIPILOT_SMOKE_RESULTS: resultsPath,
        FAKE_CLI_LOG: fakeLog,
        FAKE_CLI_MODE_FILE: modeFile,
        ...(crash ? { MAGIPILOT_SMOKE_CRASH: '1' } : {}),
        ...(real ? { MAGIPILOT_SMOKE_REAL: '1' } : {}),
        ...(ollama ? { MAGIPILOT_SMOKE_OLLAMA: '1' } : {}),
      },
    });
  } catch (err) {
    runError = err;
  }

  // VS Code has exited. Allow the watchdog its SIGTERM → SIGKILL window (1.5 s), then look.
  const inside = existsSync(resultsPath)
    ? JSON.parse(readFileSync(resultsPath, 'utf8'))
    : undefined;
  const watchdogPid = inside?.watchdogPid ?? undefined;
  const closedAt = Date.now();
  // Processes that existed before the run (only possible with --real) are not ours.
  const ours = () => alive().filter((pid) => !before.includes(pid));
  let leftovers = ours();
  while (
    (leftovers.length > 0 || (watchdogPid !== undefined && pidAlive(watchdogPid))) &&
    Date.now() - closedAt < 5000
  ) {
    await sleep(100);
    leftovers = ours();
  }
  const cleanupMs = Date.now() - closedAt;
  const spawned = existsSync(fakeLog)
    ? new Set(
        readFileSync(fakeLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line).pid),
      ).size
    : 0;
  const watchdogAfterClose = watchdogPid !== undefined ? pidAlive(watchdogPid) : undefined;
  const summary = {
    mode: `${crash ? 'crash (extension host SIGKILL)' : 'normal shutdown'}${real ? ', real Claude CLI' : ''}${ollama ? ', real Ollama (default settings)' : ''}`,
    marker,
    before: before.length,
    fakeProcessesSeen: spawned,
    inside,
    leftoversAfterClose: leftovers,
    watchdogAliveAfterClose: watchdogAfterClose,
    cleanupMsAfterClose: cleanupMs,
    runError: runError ? String(runError) : undefined,
  };
  for (const pid of leftovers) {
    try {
      process.kill(pid, 'SIGKILL'); // never leave the machine dirty, even on failure
    } catch {
      /* already gone */
    }
  }
  mkdirSync(dirname(benchResults), { recursive: true });
  writeFileSync(benchResults, `${JSON.stringify(summary, null, 2)}\n`);
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  if (!inside) failures.push('the in-VS Code smoke step produced no results');
  if (ollama) {
    if (inside && !inside.completion) failures.push('no completion came back from Ollama');
    if (inside && inside.ollamaRequests !== 1) {
      failures.push(`expected exactly 1 Ollama request, saw ${inside.ollamaRequests}`);
    }
    if (inside && inside.envItems !== 0) failures.push('.env produced a suggestion');
    if (runError) failures.push(`VS Code test runner: ${runError}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
    console.log(failures.length === 0 ? 'smoke:ollama PASS' : 'smoke:ollama FAIL');
    if (failures.length > 0) process.exitCode = 1;
    return;
  }
  const expected = real ? (c) => c.trim() !== '' : (c) => c === 'a + b;';
  if (inside && inside.completions.filter(expected).length < 1) {
    failures.push(`no completion came back from the ${real ? 'real' : 'fake'} CLI`);
  }
  if (inside && inside.aliveAfterCompletions.length < (real ? 1 : 2)) {
    failures.push('expected warm spare processes while VS Code was running');
  }
  if (inside && !real && !inside.hungRequest) {
    failures.push('no request was in flight at shutdown');
  }
  if (inside && !inside.watchdogAlive) failures.push('the watchdog was not running inside VS Code');
  if (watchdogAfterClose) failures.push('the watchdog survived VS Code');
  if (leftovers.length > 0) failures.push(`${leftovers.length} process(es) survived VS Code`);
  // In crash mode VS Code exits with the dead extension host's error; that is the expected path.
  if (runError && !crash) failures.push(`VS Code test runner: ${runError}`);
  if (crash && !runError)
    failures.push('crash mode: VS Code reported success, the host did not die');
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(failures.length === 0 ? 'smoke:processes PASS' : 'smoke:processes FAIL');
  if (failures.length > 0) process.exitCode = 1;
}

await main();
