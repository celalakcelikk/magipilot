// npm run smoke:vsix (docs/plans/phase-3-package.md AC3, K5): installs the packaged .vsix into an
// isolated VS Code stable (temporary extensions and user-data directories) with VS Code's own CLI,
// then runs test/smoke-vsix/index.ts in that VS Code. The extension under test is the installed
// copy: the development path is a stub folder, so the repository's copy is never loaded. Calls no
// CLI (no quota).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from '@vscode/test-electron';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const id = `${pkg.publisher}.${pkg.name}`;
const vsix = join(root, `${pkg.name}-${pkg.version}.vsix`);
const tempRoot = mkdtempSync(join(tmpdir(), 'magipilot-smoke-vsix-'));
const extensionsDir = join(tempRoot, 'extensions');
const userDataDir = join(tempRoot, 'user-data');
const workspace = join(tempRoot, 'workspace');
const host = join(tempRoot, 'host');
const resultsPath = join(tempRoot, 'results.json');
const benchResults = join(root, '.bench', 'smoke-vsix.json');

function cli(vscodeExecutablePath, args) {
  const [command, ...base] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
  // VS Code's CLI sets ELECTRON_RUN_AS_NODE itself; an inherited value would confuse the launch.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return execFileSync(
    command,
    [...base, `--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`, ...args],
    { encoding: 'utf8', env },
  );
}

async function main() {
  if (!existsSync(vsix)) throw new Error(`${vsix} is missing: run npm run package first`);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(userDataDir, 'User'), { recursive: true });
  // The stub development extension: runTests needs one, and it must not be Magipilot.
  mkdirSync(host, { recursive: true });
  writeFileSync(
    join(host, 'package.json'),
    JSON.stringify({
      name: 'magipilot-smoke-vsix-host',
      publisher: 'test',
      version: '0.0.0',
      engines: { vscode: '^1.140.0' },
    }),
  );

  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version: 'stable',
    cachePath: join(root, '.vscode-test'),
  });
  cli(vscodeExecutablePath, ['--install-extension', vsix]);
  const listed = cli(vscodeExecutablePath, ['--list-extensions', '--show-versions'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // A non-zero exit or a signal of VS Code is a failure too, even after clean results (PKG-I001).
  let runError;
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: host,
    extensionTestsPath: join(root, 'out', 'test', 'smoke-vsix', 'index.js'),
    launchArgs: [
      workspace,
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--disable-workspace-trust',
    ],
    extensionTestsEnv: {
      MAGIPILOT_VSIX_ID: id,
      MAGIPILOT_VSIX_VERSION: pkg.version,
      MAGIPILOT_VSIX_EXTENSIONS_DIR: extensionsDir,
      MAGIPILOT_VSIX_RESULTS: resultsPath,
    },
  }).catch((err) => {
    runError = err;
  });

  const inside = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, 'utf8')) : null;
  const failures = [];
  if (!listed.includes(`${id}@${pkg.version}`)) {
    failures.push(`not listed as ${id}@${pkg.version} (listed: ${listed.join(', ')})`);
  }
  if (!inside) failures.push('the test inside VS Code wrote no results');
  else failures.push(...inside.failures);
  if (runError) {
    failures.push(
      `VS Code did not exit cleanly: ${runError instanceof Error ? runError.message : String(runError)}`,
    );
  }

  mkdirSync(dirname(benchResults), { recursive: true });
  writeFileSync(benchResults, `${JSON.stringify({ listed, inside, failures }, null, 2)}\n`);
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.log(`smoke:vsix ${failures.length ? 'FAIL' : 'PASS'}`);
  return failures.length ? 1 : 0;
}

try {
  process.exitCode = await main();
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
