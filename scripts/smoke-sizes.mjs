// npm run smoke:sizes (P5, docs/plans/phase-4-sizes.md): the context size a user chooses, through
// Copilot Chat in VS Code stable with an isolated profile and the fake CLI as `claude` and `codex`.
// No real CLI call and no quota. Haiku's default size is the 128K tier (test-only setting S7);
// GPT-6-Luna keeps its full size. Runs test/smoke-sizes/index.ts; results in .bench/smoke-sizes.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'magipilot-smoke-sizes-'));
const workspace = join(tempRoot, 'workspace');
const userDataDir = join(tempRoot, 'user-data');
const resultsPath = join(tempRoot, 'results.json');
const fakeLog = join(tempRoot, 'fake.jsonl');
const fakeCli = join(root, 'test', 'fixtures', 'fake-cli', 'fake-cli.mjs');
const benchResults = join(root, '.bench', 'smoke-sizes.json');
const TIER = 128_000;
/** Copilot's Ask-mode system text and Magipilot's transcript tags on top of the conversation. */
const ALLOWANCE = 16_000;

function prepare() {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'notes.txt'), 'synthetic\n');
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
        'magipilot.claude.path': fakeCli,
        'magipilot.codex.path': fakeCli,
        'magipilot.chat.claude.models': ['haiku'],
        'magipilot.chat.codex.models': ['gpt-6-luna'],
        'magipilot.chat.discoverModels': true,
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  rmSync(benchResults, { force: true });
  prepare();
  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: 'stable',
    cachePath: join(root, '.vscode-test'),
  });
  let runError;
  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'out', 'test', 'smoke-sizes', 'index.js'),
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
        MAGIPILOT_TEST_CONTEXT_DEFAULT: `claude-cli.haiku=${TIER}`,
        MAGIPILOT_SMOKE_SIZES_RESULTS: resultsPath,
        // The fake CLI: the real model lists and windows, a log with stdin facts (no text).
        FAKE_CLI_MODELS: '1',
        FAKE_CLI_LOG: fakeLog,
        FAKE_CLI_STDIN_MARKERS: 'Q1-START,Q1-END,Q2-START,Q2-END',
        FAKE_CLI_TEXT: 'ok',
      },
    });
  } catch (err) {
    runError = err;
  }
  const inside = existsSync(resultsPath)
    ? JSON.parse(readFileSync(resultsPath, 'utf8'))
    : undefined;
  const fake = existsSync(fakeLog)
    ? readFileSync(fakeLog, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  // The agent-mode requests that reached the CLI: whether each question arrived whole.
  const agentStdin = fake
    .filter(
      (entry) =>
        entry.stdinMarkers && (entry.stdinMarkers['Q1-START'] || entry.stdinMarkers['Q2-START']),
    )
    .map((entry) => ({ stdinChars: entry.stdinChars, markers: entry.stdinMarkers }));
  const summary = { inside, agentStdin, runError: runError ? String(runError) : undefined };
  mkdirSync(dirname(benchResults), { recursive: true });
  writeFileSync(benchResults, `${JSON.stringify(summary, null, 2)}\n`);
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  const haiku = inside?.['ask-haiku'] ?? [];
  const luna = inside?.['ask-luna'] ?? [];
  const agent = inside?.agent ?? [];
  if (!inside) failures.push('no results from VS Code');
  if (inside && inside.models?.haiku?.contextTier?.default !== TIER)
    failures.push('haiku does not default to the 128K tier');
  if (haiku.length !== 8 || haiku.some((r) => r.missing)) failures.push('haiku: a turn is missing');
  if (haiku.some((r) => r.contextTier !== TIER)) failures.push('haiku: a request without the tier');
  if (!haiku.some((r) => r.droppedMessages > 0)) failures.push('haiku: nothing was left out');
  if (haiku.some((r) => r.droppedMessages > 0 && r.promptChars > TIER + ALLOWANCE))
    failures.push('haiku: a trimmed prompt exceeds the tier');
  if (luna.length !== 8 || luna.some((r) => r.missing)) failures.push('luna: a turn is missing');
  if (luna.some((r) => r.droppedMessages !== 0 || r.contextTier !== undefined))
    failures.push('luna: its full size left something out');
  if (agent.length !== 2 || agent.some((r) => r.missing)) failures.push('agent: a turn is missing');
  if (agent.some((r) => r.contextTier !== TIER || !(r.tools > 0)))
    failures.push('agent: a request without tools or the tier');
  for (const k of [1, 2]) {
    const sent = agentStdin.filter((entry) => entry.markers[`Q${k}-START`]);
    if (sent.length === 0) failures.push(`agent: question ${k} never reached the CLI`);
    // The newest request with this question carries it whole: Copilot did not cut it (D7, D8).
    else if (!sent.at(-1).markers[`Q${k}-END`]) failures.push(`agent: question ${k} was cut`);
  }
  if (runError) failures.push(`VS Code test runner: ${runError}`);
  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(failures.length === 0 ? 'smoke:sizes PASS' : 'smoke:sizes FAIL');
  if (failures.length > 0) process.exitCode = 1;
}

await main();
