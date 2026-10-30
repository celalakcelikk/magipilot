// npm run bench — runs the completion bench matrix against real backends.
// Usage: npm run bench -- [--only row1,row2] [--samples N] [--out .bench/results.json]
// An existing --out file is updated in place: re-run rows replace their previous results.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { ProcessRegistry } from '../src/core/process/runner';
import { BENCH_SETTINGS, createMatrix, type BenchRow } from './bench/matrix';
import { loadSamples, type BenchSample } from './bench/samples';
import { rescoreResults } from './bench/rescore';
import { scoreCompletion, summarizeRow } from './bench/stats';
import type { BenchResults, RequestRecord, RowResult } from './bench/results';

const ROOT = join(__dirname, '..');
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';

function parseArgs(argv: string[]): { only?: string[]; samples?: number; out: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const only = get('--only')
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const samples = get('--samples');
  return {
    only,
    samples: samples ? Number.parseInt(samples, 10) : undefined,
    out: get('--out') ?? join(ROOT, '.bench', `results-${Date.now()}.json`),
  };
}

function version(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return 'unavailable';
  }
}

async function environment(): Promise<BenchResults['environment']> {
  let ollama = 'unavailable';
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(5000) });
    ollama = ((await res.json()) as { version?: string }).version ?? 'unknown';
  } catch {
    /* recorded as unavailable */
  }
  return {
    os: `${process.platform} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    claude: version('claude', ['--version']),
    codex: version('codex', ['--version']),
    ollama,
  };
}

function save(path: string, results: BenchResults): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
}

async function runRow(
  row: BenchRow,
  registry: ProcessRegistry,
  samples: ReturnType<typeof loadSamples>,
): Promise<RowResult> {
  const ctx = { registry, ollamaUrl: OLLAMA_URL };
  const startedAt = new Date().toISOString();
  const setupInfo = row.setup ? await row.setup(ctx) : undefined;
  const requests: RequestRecord[] = [];
  try {
    for (const [index, sample] of samples.entries()) {
      const attempt = await row.complete(ctx, sample);
      const score = attempt.ok ? scoreCompletion(attempt.text, sample.expected) : undefined;
      requests.push({
        sampleId: sample.id,
        turn: index + 1,
        ok: attempt.ok,
        error: attempt.error,
        totalMs: attempt.totalMs,
        firstTextMs: attempt.firstTextMs,
        initMs: attempt.initMs,
        serverTtftMs: attempt.serverTtftMs,
        usage: attempt.usage,
        output: attempt.text,
        processed: attempt.processed,
        resultMs: attempt.resultMs,
        cleaned: score?.cleaned,
        exact: score?.exact,
        exactLoose: score?.exactLoose,
        similarity: score?.similarity,
      });
      console.error(
        `[bench] ${row.id} ${sample.id}: ${attempt.ok ? 'ok' : `ERROR ${attempt.error ?? ''}`} total=${attempt.totalMs ?? '-'}ms first=${attempt.firstTextMs ?? '-'}ms sim=${score?.similarity.toFixed(2) ?? '-'}`,
      );
    }
  } finally {
    await row.teardown?.(ctx);
  }
  return {
    id: row.id,
    backend: row.backend,
    mode: row.mode,
    model: row.model,
    notes: row.notes,
    startedAt,
    finishedAt: new Date().toISOString(),
    setupInfo,
    requests,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allSamples = loadSamples();
  const samples = args.samples ? allSamples.slice(0, args.samples) : allSamples;
  const matrix = createMatrix().filter((row) => !args.only || args.only.includes(row.id));
  if (matrix.length === 0) throw new Error(`no rows match --only ${args.only?.join(',')}`);

  const registry = new ProcessRegistry();
  registry.installExitHandlers();
  try {
    await runMatrix(args, allSamples, samples, matrix, registry);
  } finally {
    registry.dispose();
  }
}

async function runMatrix(
  args: ReturnType<typeof parseArgs>,
  allSamples: BenchSample[],
  samples: BenchSample[],
  matrix: BenchRow[],
  registry: ProcessRegistry,
): Promise<void> {
  const results: BenchResults = existsSync(args.out)
    ? (JSON.parse(readFileSync(args.out, 'utf8')) as BenchResults)
    : {
        version: 1,
        startedAt: new Date().toISOString(),
        environment: await environment(),
        settings: BENCH_SETTINGS,
        sampleCount: samples.length,
        rows: {},
      };

  const runStartedAt = new Date().toISOString();
  console.error(`[bench] ${matrix.length} rows × ${samples.length} samples → ${args.out}`);
  for (const row of matrix) {
    results.rows[row.id] = await runRow(row, registry, samples);
    // Rows kept from earlier runs are rescored too, so the file never mixes scoring versions.
    rescoreResults(results, allSamples);
    save(args.out, results); // keep partial results if a later row fails (e.g. quota)
    const stats = summarizeRow(results.rows[row.id]!.requests);
    console.error(
      `[bench] ${row.id} done: ok ${stats.ok}/${stats.attempts}, p50 ${stats.p50TotalMs ?? '-'} ms, p95 ${stats.p95TotalMs ?? '-'} ms`,
    );
  }

  const leaked = registry.leakedPids();
  // One entry per invocation, so partial re-runs (--only) keep the earlier runs' process counts.
  results.runs = [
    ...(results.runs ?? []),
    {
      startedAt: runStartedAt,
      rows: matrix.map((row) => row.id),
      processes: { started: registry.startedCount, leaked: leaked.length },
    },
  ];
  save(args.out, results);
  console.log(`written: ${args.out}`);
  console.log(`leaked: ${leaked.length}`);
  if (leaked.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
