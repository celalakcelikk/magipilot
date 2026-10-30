import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// Synthetic workspace for the inline provider tests (test/integration/inline.test.ts). Generated
// per run, so no secret-looking files live in the repository. All values are fake.
function prepareWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'magipilot-it-'));
  // A file outside the workspace folder, for the import-signature tests (phase-3-context P5).
  const outside = mkdtempSync(join(tmpdir(), 'magipilot-out-'));
  writeFileSync(join(outside, 'leak.ts'), 'export function outsideLeak(): void {}\n');
  const files = {
    '.env': 'API_KEY=not-a-real-secret-0001\nexport function add mul\n',
    '.env.local': 'API_KEY=not-a-real-secret-0002\n',
    'cert.pem': '-----BEGIN NOT A REAL CERTIFICATE-----\nnot-a-real-secret-0003\n',
    'secrets/key.txt': 'not-a-real-secret-0004\n',
    'secrets/keys.ts': "export const mulKey = 'not-a-real-secret-0005'; // add mul\n",
    'src/a.ts':
      "import { mul } from './b';\n\nexport function add(a: number, b: number): number {\n  return \n}\n",
    'src/b.ts': 'export function mul(a: number, b: number): number {\n  return a * b;\n}\n',
    'notes.txt': 'plain notes\n',
    // Import signatures (phase-3-context P5): c.ts imports d (allowed) and only forbidden files besides.
    'src/c.ts': [
      "import { add } from './d';",
      "import { mulKey } from '../secrets/keys';",
      "import * as env from './link-env';",
      "import * as secret from './link-secret';",
      "import * as out from './link-out';",
      `import * as away from '../../${basename(outside)}/leak';`,
      '',
      'export const total = ',
      '',
    ].join('\n'),
    'src/d.ts':
      'export function add(a: number, b: number): number {\n  return a + b; // D-BODY\n}\n',
    '.env.d.ts': 'export function envSecret(): string;\n// not-a-real-secret-0006\n',
    'secrets/api.ts':
      'export function leakSecret(token: string): void {}\n// not-a-real-secret-0007\n',
    'src/e.ts': "import { shared } from './shared';\n\nexport const v = \n",
    'data/shared.source': 'export function shared(n: number): number {\n  return n;\n}\n',
    'py/main.py': 'from .util import add\n\nresult = \n',
    'py/util.py': 'def add(a: int, b: int) -> int:\n    return a + b  # UTIL-BODY\n',
  };
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
  }
  // Model discovery off (phase-4-models.md): no test asks the real CLIs for their models. The
  // discovery tests turn it on at workspace level.
  mkdirSync(join(root, '.vscode'), { recursive: true });
  writeFileSync(
    join(root, '.vscode', 'settings.json'),
    JSON.stringify({ 'magipilot.chat.discoverModels': false }),
  );
  symlinkSync('../.env.d.ts', join(root, 'src/link-env.ts'));
  symlinkSync('../secrets/api.ts', join(root, 'src/link-secret.ts'));
  symlinkSync(join(outside, 'leak.ts'), join(root, 'src/link-out.ts'));
  symlinkSync('../data/shared.source', join(root, 'src/shared.ts'));
  process.on('exit', () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  return root;
}

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  version: 'stable',
  workspaceFolder: prepareWorkspace(),
  launchArgs: ['--disable-workspace-trust'],
  env: { MAGIPILOT_TEST: '1' },
  mocha: {
    ui: 'bdd',
    timeout: 30000,
  },
});
