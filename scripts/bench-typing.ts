// `npm run bench:typing`: debounce tuning by typing replay (docs/plans/phase-3-metrics.md M4,
// AC4). Reads the bench samples and the latencies recorded in test/fixtures/bench-data/; makes no CLI or
// HTTP call. Writes the raw result as JSON and prints the markdown tables for docs/bench.md.
//
//   npm run bench:typing -- [--seeds N] [--out .bench/typing-<date>.json]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CACHE_CAPACITY } from '../src/core/cache';
import { CLI_DEBOUNCE_MS, LOCAL_DEBOUNCE_MS } from '../src/features/inline/rules';
import { loadSamples } from './bench/samples';
import {
  drawLatencies,
  HEAVY_TAIL_MODEL,
  keystrokes,
  M4_MODEL,
  median,
  medianSummary,
  mulberry32,
  simulate,
  summarize,
  verdict,
  type RunSummary,
  type TypingModel,
  type Verdict,
} from './lib/typing/sim';

const MODELS: readonly TypingModel[] = [M4_MODEL, HEAVY_TAIL_MODEL];

interface BackendSource {
  id: string;
  file: string;
  row: string;
}

interface BackendClass {
  name: 'local' | 'cli';
  /** The Faz 1 default (D6) the rule compares against. */
  defaultMs: number;
  /** The default in the code now (src/features/inline/rules.ts). */
  codeMs: number;
  candidates: readonly number[];
  /** M4: most the p50 time to suggestion after a pause may grow. */
  maxGrowthMs: number;
  backends: readonly BackendSource[];
}

// The rows of the production backends' code path; Codex has only the Faz 0 row (gpt-6-luna, the
// default inline model).
const CLASSES: readonly BackendClass[] = [
  {
    name: 'local',
    defaultMs: 200,
    codeMs: LOCAL_DEBOUNCE_MS,
    // 250 ms: the top of PLAN §6.1's local range (150–250 ms), added in the build (see the log).
    candidates: [100, 150, 200, 250, 300],
    maxGrowthMs: 100,
    backends: [
      {
        id: 'ollama',
        file: 'test/fixtures/bench-data/2026-10-27-phase1-local.json',
        row: 'prod-ollama-1.5b',
      },
      {
        id: 'openai-compat',
        file: 'test/fixtures/bench-data/2026-10-27-phase1-local.json',
        row: 'prod-oai-1.5b',
      },
    ],
  },
  {
    name: 'cli',
    defaultMs: 700,
    codeMs: CLI_DEBOUNCE_MS,
    candidates: [400, 700, 1000, 1500],
    maxGrowthMs: 300,
    backends: [
      {
        id: 'claude-cli',
        file: 'test/fixtures/bench-data/2026-10-27-phase1-r2.json',
        row: 'prod-claude-warm',
      },
      { id: 'codex-cli', file: 'test/fixtures/bench-data/2026-10-26.json', row: 'codex-luna-cold' },
    ],
  },
];

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const SEEDS = Number(argValue('--seeds', '20'));
if (!Number.isInteger(SEEDS) || SEEDS < 1) throw new Error('--seeds must be a positive integer');
const OUT = argValue('--out', `.bench/typing-${new Date().toISOString().slice(0, 10)}.json`);

interface RecordedRow {
  id: string;
  requests: { ok: boolean; totalMs: number }[];
}

function recordedLatencies(source: BackendSource): number[] {
  const data = JSON.parse(readFileSync(source.file, 'utf8')) as {
    rows: RecordedRow[] | Record<string, RecordedRow>;
  };
  const rows = Array.isArray(data.rows) ? data.rows : Object.values(data.rows);
  const row = rows.find((r) => r.id === source.row);
  if (!row) throw new Error(`${source.file}: no row ${source.row}`);
  const latencies = row.requests.filter((r) => r.ok).map((r) => r.totalMs);
  if (latencies.length === 0)
    throw new Error(`${source.file}: row ${source.row} has no ok request`);
  return latencies;
}

/** A distinct, stable seed per (seed, stream, sample). */
function streamSeed(seed: number, stream: string, sample: number): number {
  let h = 2166136261 ^ seed;
  for (const char of `${stream}#${sample}`) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** `magipilot.inline.maxLines` default: the longest suggestion, in lines. */
const MAX_LINES = (() => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
  };
  const value = pkg.contributes.configuration.properties['magipilot.inline.maxLines']?.default;
  if (typeof value !== 'number')
    throw new Error('package.json: no default for magipilot.inline.maxLines');
  return value;
})();

// The code as written: the fixtures' <FILL> markers are not part of it (METRICS-I002).
const samples = loadSamples().map((sample) => ({
  name: sample.id,
  text: sample.prefix + sample.expected + sample.suffix,
}));

interface BackendResult {
  source: BackendSource;
  recorded: { count: number; p50Ms: number };
  /** model → debounce → median over seeds. */
  results: Record<string, Record<number, RunSummary>>;
  verdicts: Record<string, Verdict[]>;
}

interface ClassResult {
  name: string;
  defaultMs: number;
  candidates: readonly number[];
  maxGrowthMs: number;
  backends: BackendResult[];
  /** model → candidates that pass the rule for every backend of the class. */
  passing: Record<string, number[]>;
  decision: string;
  /** The default the decision asks for. */
  decidedMs: number;
  codeMs: number;
}

let typedKeys = 0;
const classResults: ClassResult[] = CLASSES.map((cls) => {
  const backends: BackendResult[] = cls.backends.map((source) => {
    const recorded = recordedLatencies(source);
    const results: Record<string, Record<number, RunSummary>> = {};
    for (const model of MODELS) {
      const perDebounce: Record<number, RunSummary[]> = {};
      for (let seed = 1; seed <= SEEDS; seed++) {
        // The same keystrokes and latencies for every candidate (common random numbers).
        const sessions = samples.map((sample, j) => {
          const keys = keystrokes(sample.text, model, mulberry32(streamSeed(seed, model.name, j)));
          const latencies = drawLatencies(
            keys.length,
            recorded,
            mulberry32(streamSeed(seed, `latency:${source.id}`, j)),
          );
          if (seed === 1 && model === M4_MODEL && source === CLASSES[0]!.backends[0])
            typedKeys += keys.length;
          return { keys, latencies };
        });
        for (const debounce of cls.candidates) {
          (perDebounce[debounce] ??= []).push(
            summarize(sessions.map((s) => simulate(s.keys, debounce, s.latencies, MAX_LINES))),
          );
        }
      }
      results[model.name] = Object.fromEntries(
        cls.candidates.map((d) => [d, medianSummary(perDebounce[d]!)]),
      );
    }
    const verdicts = Object.fromEntries(
      MODELS.map((model) => {
        const byDebounce = results[model.name]!;
        return [
          model.name,
          cls.candidates
            .filter((d) => d !== cls.defaultMs)
            .map((d) => verdict(byDebounce[cls.defaultMs]!, byDebounce[d]!, d, cls.maxGrowthMs)),
        ];
      }),
    );
    return {
      source,
      recorded: { count: recorded.length, p50Ms: median(recorded) },
      results,
      verdicts,
    };
  });
  const passing = Object.fromEntries(
    MODELS.map((model) => [
      model.name,
      cls.candidates.filter(
        (d) =>
          d !== cls.defaultMs &&
          backends.every((b) => b.verdicts[model.name]!.find((v) => v.candidateMs === d)!.pass),
      ),
    ]),
  );
  const m4 = passing[M4_MODEL.name]!;
  let decision: string;
  let decidedMs = cls.defaultMs;
  if (m4.length === 0) {
    decision = `keep ${cls.defaultMs} ms: no candidate passes the M4 rule for every ${cls.name} backend`;
  } else {
    const chosen = [...m4].sort(
      (a, b) => Math.abs(a - cls.defaultMs) - Math.abs(b - cls.defaultMs),
    )[0]!;
    if (passing[HEAVY_TAIL_MODEL.name]!.includes(chosen)) {
      decidedMs = chosen;
      decision = `change ${cls.defaultMs} → ${chosen} ms: the passing candidate closest to the default; it passes the M4 rule for every ${cls.name} backend, and the sensitivity variant agrees`;
    } else {
      decision = `keep ${cls.defaultMs} ms (host judgment): ${chosen} ms passes the M4 rule, but not under the sensitivity variant`;
    }
  }
  return {
    name: cls.name,
    defaultMs: cls.defaultMs,
    candidates: cls.candidates,
    maxGrowthMs: cls.maxGrowthMs,
    backends,
    passing,
    decision,
    decidedMs,
    codeMs: cls.codeMs,
  };
});

const allSummaries = classResults.flatMap((c) =>
  c.backends.flatMap((b) =>
    Object.values(b.results).flatMap((byDebounce) => Object.values(byDebounce)),
  ),
);
const maxStored = Math.max(...allSummaries.map((r) => r.maxStoredPerFile));
const maxLive = Math.max(...allSummaries.map((r) => r.maxLiveEntries));
// The working set is what could still be hit: a completion is reachable only while the user types
// through it, at most MAX_LINES lines below its anchor. Older entries are evicted first (LRU).
const cacheDecision =
  maxLive <= CACHE_CAPACITY
    ? `keep ${CACHE_CAPACITY}: at most ${maxLive} stored completions could still be hit at one time (a file session stores up to ${maxStored}; the older ones are unreachable and evicted first)`
    : `revisit: up to ${maxLive} stored completions could still be hit at one time, more than ${CACHE_CAPACITY}`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      version: 1,
      generatedAt: new Date().toISOString(),
      seeds: SEEDS,
      samples: samples.map((s) => s.name),
      keystrokesPerSeed: typedKeys,
      models: MODELS.map((m) => ({ name: m.name, description: m.description })),
      classes: classResults,
      cache: {
        capacity: CACHE_CAPACITY,
        maxLines: MAX_LINES,
        maxStoredPerFile: maxStored,
        maxLiveEntries: maxLive,
        decision: cacheDecision,
      },
    },
    null,
    2,
  ) + '\n',
);

const fmt = (n: number, digits = 1): string => (Number.isFinite(n) ? n.toFixed(digits) : '—');
const lines: string[] = [];
lines.push(
  `Seeds: ${SEEDS} (medians across seeds). Samples: ${samples.length} files, ${typedKeys} keystrokes per seed. Raw: \`${OUT}\`.`,
  '',
);
for (const model of MODELS) lines.push(`- **${model.name}**: ${model.description}`);
for (const cls of classResults) {
  for (const model of MODELS) {
    lines.push(
      '',
      `#### ${cls.name} backends — ${model.name}${model === M4_MODEL ? ' (the M4 model)' : ' (sensitivity, not the M4 model)'}`,
      '',
      '| Backend | Debounce | Requests /100 keys | Wasted /100 keys | Shown /100 keys | Pauses served | Time to suggestion p50 | Waste cut | TTS growth | Rule |',
      '|---|---|---|---|---|---|---|---|---|---|',
    );
    for (const b of cls.backends) {
      for (const d of cls.candidates) {
        const r = b.results[model.name]![d]!;
        const v = b.verdicts[model.name]!.find((x) => x.candidateMs === d);
        lines.push(
          `| ${b.source.id} | ${d} ms${d === cls.defaultMs ? ' (default)' : ''} | ${fmt(r.requestsPer100)} | ${fmt(r.wastedPer100)} | ${fmt(r.shownPer100)} | ${fmt(r.pausesServedPct, 0)} % | ${fmt(r.timeToSuggestionP50Ms, 0)} ms | ${v ? `${fmt(100 * v.wasteCut, 0)} %` : '—'} | ${v ? `${v.timeToSuggestionGrowthMs >= 0 ? '+' : ''}${fmt(v.timeToSuggestionGrowthMs, 0)} ms` : '—'} | ${v ? (v.pass ? 'PASS' : 'FAIL') : 'default'} |`,
        );
      }
    }
    const pass = cls.passing[model.name]!;
    lines.push(
      '',
      `Passing for every ${cls.name} backend: ${pass.length ? pass.map((d) => `${d} ms`).join(', ') : 'none'}.`,
    );
  }
  lines.push(
    '',
    `**Decision (${cls.name}): ${cls.decision}.** Code default now: ${cls.codeMs} ms (${cls.codeMs === cls.decidedMs ? 'matches the decision' : `MISMATCH: the decision asks for ${cls.decidedMs} ms`}).`,
  );
}
lines.push('', `**Cache: ${cacheDecision}.**`);
for (const cls of classResults) {
  for (const b of cls.backends) {
    lines.push(
      `- ${b.source.id}: ${b.recorded.count} recorded latencies (p50 ${fmt(b.recorded.p50Ms, 0)} ms), \`${b.source.file}\` row \`${b.source.row}\``,
    );
  }
}
console.log(lines.join('\n'));
