// npm run smoke:processes (P10, docs/plans/phase-1.md) — AGENTS rule 8: no CLI process may
// survive VS Code. Launches VS Code stable (isolated profile) with the CLI paths set to programs in
// a folder whose name is a unique marker (the fake CLI, or wrappers around the real CLIs), runs
// test/smoke/index.ts, lets VS Code close with a request in flight, then looks for any process this
// run owns (docs/plans/phase-5-linux.md D7): one whose command line carries the marker, or a live
// member of a process group the extension started. Nothing else is reported or killed.
import { execFileSync, spawn } from 'node:child_process';
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
import { classifyLeftovers, isClean, killOwned } from './lib/leftovers.mjs';
import { lmFailures } from './lib/smokeVerdict.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// --crash: the extension host SIGKILLs itself instead of shutting down (watchdog path, D13).
const crash = process.argv.includes('--crash');
// --real (P11, real quota: ~5 Claude calls): the real `claude` through a wrapper in the marker
// folder; run manually after `node esbuild.mjs --tests`.
const real = process.argv.includes('--real');
// --real-codex (phase-5-linux D8, ~5 Codex calls): the same inline flow with the real Codex.
const realCodex = process.argv.includes('--real-codex');
// --lm (phase-5-linux D3, 2 model calls): one chat request each to a Claude and a Codex model
// through vscode.lm, with the models that discovery finds.
const lm = process.argv.includes('--lm');
// --ollama (Loop C, C-AC4): default settings (inline.backend = ollama) against the real local
// Ollama; checks one completion and that an excluded .env sends nothing. No CLI is involved.
const ollama = process.argv.includes('--ollama');
const realCli = real || realCodex || lm;
const marker = `mpsmoke${randomBytes(6).toString('hex')}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'magipilot-smoke-'));
const binDir = join(tempRoot, marker);
const fakeClaude = join(binDir, 'claude');
const workspace = join(tempRoot, 'workspace');
const userDataDir = join(tempRoot, 'user-data');
const extensionsDir = join(tempRoot, 'extensions');
const fakeLog = join(tempRoot, 'fake-cli.jsonl');
const modeFile = join(tempRoot, 'fake-mode');
const resultsPath = join(tempRoot, 'smoke-results.json');
const suffix = [
  crash && 'crash',
  real && 'real',
  realCodex && 'real-codex',
  lm && 'lm',
  ollama && 'ollama',
].filter(Boolean);
const benchResults = join(
  root,
  '.bench',
  `smoke-processes${suffix.map((part) => `-${part}`).join('')}.json`,
);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function pgrep(pattern) {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** Processes whose command line carries this run's marker. */
const alive = () => pgrep(marker);

/** The process group of `pid`, or undefined once it is gone. */
function pgidOf(pid) {
  try {
    const pgid = Number(
      execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }),
    );
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

function which(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `/bin/sh` wrapper in the marker folder that runs `target` as its child, without `exec`, so
 * every CLI process Magipilot starts has a marker-bearing parent in its group (D7).
 */
function writeWrapper(name, target) {
  const path = join(binDir, name);
  const quoted = `'${target.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    path,
    `#!/bin/sh\n# Magipilot smoke wrapper (docs/plans/phase-5-linux.md D7).\n${quoted} "$@"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Processes that look like the CLIs' own command lines but are not this run's (A7): the old
 * command-line snapshot would have killed such a process when it started during a run. They carry
 * no marker and are in no recorded group, so they must still be alive afterwards.
 */
function startDecoys() {
  return [
    ['claude', '-p', '--tools', ''],
    ['codex', 'exec', '--json', '-'],
  ].map((args) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)', '--', ...args], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return child.pid;
  });
}

function cliSettings() {
  // --ollama keeps every magipilot setting at its default (inline.backend = ollama).
  if (ollama) return {};
  if (!realCli) {
    copyFileSync(join(root, 'test', 'fixtures', 'fake-cli', 'fake-cli.mjs'), fakeClaude);
    chmodSync(fakeClaude, 0o755);
    return {
      'magipilot.inline.backend': 'claude-cli',
      'magipilot.claude.path': fakeClaude,
      'magipilot.claude.warmPoolSize': 2,
    };
  }
  const claude = which('claude');
  const codex = which('codex');
  if ((real || lm) && !claude) throw new Error('`claude` is not on PATH');
  if ((realCodex || lm) && !codex) throw new Error('`codex` is not on PATH');
  return {
    // --lm sends chat requests only; inline completions stay off so nothing else is spent.
    ...(lm ? { 'magipilot.inline.enabled': false } : {}),
    'magipilot.inline.backend': realCodex ? 'codex-cli' : 'claude-cli',
    // Both CLIs go through wrappers whenever they are installed, so discovery and probes are
    // owned too.
    ...(claude
      ? {
          'magipilot.claude.path': writeWrapper('claude', claude),
          'magipilot.claude.warmPoolSize': 1,
        }
      : {}),
    ...(codex ? { 'magipilot.codex.path': writeWrapper('codex', codex) } : {}),
  };
}

function prepare() {
  mkdirSync(binDir, { recursive: true });
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
        ...cliSettings(),
      },
      null,
      2,
    )}\n`,
  );
}

/** Ends the decoys' groups; they are this script's own processes. */
function stopDecoys(decoys) {
  for (const pid of decoys) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function main() {
  rmSync(benchResults, { force: true });
  let decoys = [];
  try {
    const vscodeExecutablePath = await downloadAndUnzipVSCode({
      version: 'stable',
      cachePath: join(root, '.vscode-test'),
    });
    prepare();
    // Real claude/codex processes that are not ours (another window, this terminal's own session)
    // are only reported: they may end on their own. The decoys must survive (A7).
    const strangers = pgrep('(^|/)(claude|codex)( |$)');
    decoys = ollama ? [] : startDecoys();
    await check(vscodeExecutablePath, strangers, decoys);
  } finally {
    // Whatever failed above, nothing of this run stays behind (inspection LINUX-I002).
    stopDecoys(decoys);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function check(vscodeExecutablePath, strangers, decoys) {
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
        ...(realCodex ? { MAGIPILOT_SMOKE_REAL_CODEX: '1' } : {}),
        ...(lm ? { MAGIPILOT_SMOKE_LM: '1' } : {}),
        ...(ollama ? { MAGIPILOT_SMOKE_OLLAMA: '1' } : {}),
        ...(process.env.MAGIPILOT_SMOKE_LM_CLAUDE
          ? { MAGIPILOT_SMOKE_LM_CLAUDE: process.env.MAGIPILOT_SMOKE_LM_CLAUDE }
          : {}),
        ...(process.env.MAGIPILOT_SMOKE_LM_CODEX
          ? { MAGIPILOT_SMOKE_LM_CODEX: process.env.MAGIPILOT_SMOKE_LM_CODEX }
          : {}),
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
  const recordedGroups = inside?.startedGroups ?? [];
  const owned = () =>
    classifyLeftovers({ markerPids: alive(), recordedGroups, groupAlive, pgidOf });
  const closedAt = Date.now();
  let leftovers = owned();
  while (
    (!isClean(leftovers) || (watchdogPid !== undefined && pidAlive(watchdogPid))) &&
    Date.now() - closedAt < 5000
  ) {
    await sleep(100);
    leftovers = owned();
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
  const strangersGone = strangers.filter((pid) => !pidAlive(pid));
  const decoysGone = decoys.filter((pid) => !pidAlive(pid));
  const summary = {
    mode: [
      crash ? 'crash (extension host SIGKILL)' : 'normal shutdown',
      real && 'real Claude CLI',
      realCodex && 'real Codex CLI',
      lm && 'real chat requests through vscode.lm',
      ollama && 'real Ollama (default settings)',
    ]
      .filter(Boolean)
      .join(', '),
    marker,
    fakeProcessesSeen: spawned,
    recordedGroups: recordedGroups.length,
    strangersBefore: strangers.length,
    strangersGone: strangersGone.length,
    decoys: decoys.length,
    decoysGone: decoysGone.length,
    inside,
    leftoversAfterClose: leftovers,
    watchdogAliveAfterClose: watchdogAfterClose,
    cleanupMsAfterClose: cleanupMs,
    runError: runError ? String(runError) : undefined,
  };
  killOwned(leftovers, (pid, signal) => process.kill(pid, signal)); // never leave the machine dirty
  mkdirSync(dirname(benchResults), { recursive: true });
  writeFileSync(benchResults, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  if (!inside && !lm) failures.push('the in-VS Code smoke step produced no results');
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
  if (lm) {
    failures.push(...lmFailures(inside, recordedGroups.length));
  } else if (inside) {
    const expected = realCli ? (c) => c.trim() !== '' : (c) => c === 'a + b;';
    if (inside.completions.filter(expected).length < 1) {
      failures.push(`no completion came back from the ${realCli ? 'real' : 'fake'} CLI`);
    }
    // Codex has no warm pool: a cold process per request (D8).
    if (!realCodex && inside.aliveAfterCompletions.length < (real ? 1 : 2)) {
      failures.push('expected warm spare processes while VS Code was running');
    }
    if (!realCli && !inside.hungRequest) failures.push('no request was in flight at shutdown');
    if (realCodex && !inside.shutdownRequestSeen) {
      failures.push('the Codex request left for shutdown was never seen running');
    }
    if (realCodex && inside.shutdownRequestSeen && !inside.shutdownRequestAliveAtEnd) {
      failures.push('the Codex request left for shutdown ended before VS Code closed');
    }
  }
  if (inside && !inside.watchdogAlive) failures.push('the watchdog was not running inside VS Code');
  if (watchdogAfterClose) failures.push('the watchdog survived VS Code');
  if (!isClean(leftovers)) {
    failures.push(
      `owned processes survived VS Code: ${leftovers.pids.length} marked, ${leftovers.groups.length} groups`,
    );
  }
  if (decoysGone.length > 0) {
    failures.push(`${decoysGone.length} decoy claude/codex process(es) did not survive the run`);
  }
  // In crash mode VS Code exits with the dead extension host's error; that is the expected path.
  if (runError && !crash) failures.push(`VS Code test runner: ${runError}`);
  if (crash && !runError)
    failures.push('crash mode: VS Code reported success, the host did not die');
  const name = lm ? 'smoke:lm' : 'smoke:processes';
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(failures.length === 0 ? `${name} PASS` : `${name} FAIL`);
  if (failures.length > 0) process.exitCode = 1;
}

await main();
