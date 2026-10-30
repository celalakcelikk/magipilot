// Bundles the extension (and, with --tests, the VS Code-hosted test suites) with esbuild.
// --production (`vscode:prepublish`, docs/plans/phase-3-package.md K2): minified, no source map.
import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const withTests = process.argv.includes('--tests');
const production = process.argv.includes('--production');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode', 'mocha'],
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    minify: production,
    sourcemap: !production,
  },
];

if (withTests) {
  const integrationDir = 'test/integration';
  const entryPoints = readdirSync(integrationDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(integrationDir, f));
  builds.push({ ...common, entryPoints, outdir: 'out/test/integration' });
  builds.push({
    ...common,
    entryPoints: ['test/probe/index.ts'],
    outfile: 'out/test/probe/index.js',
  });
  builds.push({
    ...common,
    entryPoints: ['test/smoke/index.ts'],
    outfile: 'out/test/smoke/index.js',
  });
  builds.push({
    ...common,
    entryPoints: ['test/smoke-chat/index.ts'],
    outfile: 'out/test/smoke-chat/index.js',
  });
  builds.push({
    ...common,
    entryPoints: ['test/smoke-vsix/index.ts'],
    outfile: 'out/test/smoke-vsix/index.js',
  });
  builds.push({
    ...common,
    entryPoints: ['test/smoke-agent/index.ts'],
    outfile: 'out/test/smoke-agent/index.js',
  });
  builds.push({
    ...common,
    entryPoints: ['test/smoke-sizes/index.ts'],
    outfile: 'out/test/smoke-sizes/index.js',
  });
}

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
