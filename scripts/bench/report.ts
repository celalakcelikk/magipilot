// npm run bench:report -- <results.json> — renders the bench results as markdown tables.
// Without an argument the newest .bench/results-*.json is used.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchResults, RowResult } from './results';
import {
  decideWarmVsSession,
  MIN_SUCCESSES,
  percentile,
  summarizeRow,
  type RowStats,
} from './stats';

function newestResults(): string {
  const dir = join(__dirname, '..', '..', '.bench');
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith('results-') && name.endsWith('.json'))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!candidates[0]) throw new Error('no .bench/results-*.json found');
  return candidates[0];
}

const ms = (value: number | undefined): string => (value === undefined ? '–' : `${value}`);
const pct = (value: number | undefined): string => (value === undefined ? '–' : value.toFixed(2));

function stats(row: RowResult): RowStats {
  return summarizeRow(row.requests);
}

export function renderReport(results: BenchResults): string {
  const out: string[] = [];
  const rows = Object.values(results.rows);
  const env = results.environment;

  out.push('### Environment', '');
  out.push('| Item | Value |', '|---|---|');
  out.push(`| Date | ${results.startedAt} |`);
  out.push(`| OS | ${env.os} |`, `| CPU | ${env.cpu} |`, `| Memory | ${env.memoryGb} GB |`);
  out.push(`| Node | ${env.node} |`, `| Claude Code | ${env.claude} |`);
  out.push(`| Codex | ${env.codex} |`, `| Ollama | ${env.ollama} |`);
  out.push(`| Samples per row | ${results.sampleCount} |`);
  out.push(`| Settings | \`${JSON.stringify(results.settings)}\` |`);
  if (results.processes) {
    out.push(
      `| Processes | ${results.processes.started} started, ${results.processes.leaked} leaked |`,
    );
  }
  out.push('');
  out.push(
    'Output limits: `maxTokens` and `temperature` reach the HTTP backends only (Ollama `num_predict`, OpenAI-compatible `max_tokens`) as hard limits. The CLI rows ran **without any requested output-length limit**: neither CLI has a max-tokens flag, and the completion prompt asks only for the text to insert (review P0-R3-002).',
    '',
  );
  if (results.runs && results.runs.length > 0) {
    out.push(
      '| Run | Started | Rows | Processes started | Leaked | Note |',
      '|---|---|---|---|---|---|',
    );
    results.runs.forEach((run, i) => {
      out.push(
        `| ${i + 1} | ${run.startedAt} | ${run.rows.join(', ')} | ${run.processes.started} | ${run.processes.leaked} | ${run.note ?? ''} |`,
      );
    });
    out.push('');
  }

  out.push('### Latency and indicative quality', '');
  out.push(
    '| Row | Backend | Mode | Model | ok/n | p50 total ms | p95 total ms | p50 first text ms | p95 first text ms | exact | exact ± indent | mean edit sim. |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const row of rows) {
    const s = stats(row);
    out.push(
      `| ${row.id} | ${row.backend} | ${row.mode} | ${row.model} | ${s.ok}/${s.attempts} | ${ms(s.p50TotalMs)} | ${ms(s.p95TotalMs)} | ${ms(s.p50FirstTextMs)} | ${ms(s.p95FirstTextMs)} | ${s.exactMatches} | ${s.exactLooseMatches} | ${pct(s.meanSimilarity)} |`,
    );
  }
  out.push('');
  out.push(
    `Latency is measured from sending the request (writing the prompt / HTTP request) to the complete answer; percentiles are nearest-rank over successful requests only. "first text" is the first non-empty text chunk (Codex emits the whole message at once). Quality (scoring version ${results.scoringVersion ?? 1}): "exact" ignores only trailing whitespace, so an extra leading indent or newline counts as wrong (it would be inserted at the cursor); "exact ± indent" also ignores leading whitespace and shows what indentation post-processing could recover; mean normalized edit similarity uses the strict text. All against the hand-written expected middle — indicative only (20 samples).`,
    '',
  );

  const production = rows.filter((r) => stats(r).exactProcessedMatches !== undefined);
  if (production.length > 0) {
    out.push('### Production pipeline (Faz 1)', '');
    out.push(
      '| Row | ok/n | p50 to result ms | p95 to result ms | p50 total ms | p95 total ms | exact (raw) | exact ± indent (raw) | exact after postprocess |',
      '|---|---|---|---|---|---|---|---|---|',
    );
    for (const row of production) {
      const s = stats(row);
      const toResult = row.requests.flatMap((r) =>
        r.ok && r.resultMs !== undefined ? [r.resultMs] : [],
      );
      out.push(
        `| ${row.id} | ${s.ok}/${s.attempts} | ${ms(percentile(toResult, 50))} | ${ms(percentile(toResult, 95))} | ${ms(s.p50TotalMs)} | ${ms(s.p95TotalMs)} | ${s.exactMatches} | ${s.exactLooseMatches} | ${s.exactProcessedMatches} |`,
      );
    }
    out.push(
      '',
      '"to result" = prompt written → result event, the same window as the Faz 0 rows. "total" = until `ClaudeCliBackend.complete()` returns, which also waits for the CLI to exit (the exit is classified, Faz 0 P0-R2-001): this is what the user waits for. "exact after postprocess" is the strict match of the text the extension would insert (src/core/postprocess.ts).',
      '',
    );
  }

  const local = rows.filter((r) => r.setupInfo && Object.keys(r.setupInfo).length > 0);
  if (local.length > 0) {
    out.push('### Local model warm-up (excluded from the table above)', '');
    out.push('| Row | warm-up ok | warm-up ms | model load ms |', '|---|---|---|---|');
    for (const row of local) {
      const info = row.setupInfo as { warmupOk?: boolean; warmupMs?: number; modelLoadMs?: number };
      out.push(
        `| ${row.id} | ${info.warmupOk === undefined ? '–' : String(info.warmupOk)} | ${ms(info.warmupMs)} | ${ms(info.modelLoadMs)} |`,
      );
    }
    out.push('');
  }

  const claudeRows = rows.filter((r) => r.backend === 'Claude CLI');
  if (claudeRows.length > 0) {
    out.push('### Claude start-up and server time to first token', '');
    out.push(
      '| Row | p50 spawn→init ms | p50 server TTFT ms | p50 input tokens |',
      '|---|---|---|---|',
    );
    for (const row of claudeRows) {
      const ok = row.requests.filter((r) => r.ok);
      // A warm/session process emits `init` only after its first message, so spawn→init there
      // includes the idle time and says nothing about start-up cost.
      const init = row.id.endsWith('-cold')
        ? ok.flatMap((r) => (r.initMs !== undefined ? [r.initMs] : []))
        : [];
      const ttft = ok.flatMap((r) => (r.serverTtftMs !== undefined ? [r.serverTtftMs] : []));
      const tokens = ok.flatMap((r) =>
        r.usage?.inputTokensTotal !== undefined ? [r.usage.inputTokensTotal] : [],
      );
      out.push(
        `| ${row.id} | ${ms(percentile(init, 50))} | ${ms(percentile(ttft, 50))} | ${ms(percentile(tokens, 50))} |`,
      );
    }
    out.push('');
  }

  const session = results.rows['claude-haiku-session'];
  if (session) {
    out.push('### Stream-json session: per-turn latency and context growth', '');
    out.push(
      '| Turn | Sample | ok | total ms | input tokens (incl. cache) |',
      '|---|---|---|---|---|',
    );
    for (const r of session.requests) {
      out.push(
        `| ${r.turn} | ${r.sampleId} | ${r.ok ? 'yes' : 'no'} | ${ms(r.totalMs)} | ${ms(r.usage?.inputTokensTotal)} |`,
      );
    }
    out.push('');
  }

  const warm = results.rows['claude-haiku-warm'];
  if (warm && session) {
    const decision = decideWarmVsSession(stats(warm), stats(session));
    out.push('### Warm pool vs session', '');
    out.push(`**Verdict: ${decision.verdict}** — ${decision.reason}.`, '');
  }

  if (claudeRows.length > 0) {
    out.push('### Claude model comparison (cold rows)', '');
    out.push(
      '| Model | ok/n | p50 total ms | exact | exact ± indent | mean edit sim. | eligible |',
      '|---|---|---|---|---|---|---|',
    );
    for (const row of claudeRows.filter((r) => r.id.endsWith('-cold'))) {
      const s = stats(row);
      out.push(
        `| ${row.model} | ${s.ok}/${s.attempts} | ${ms(s.p50TotalMs)} | ${s.exactMatches} | ${s.exactLooseMatches} | ${pct(s.meanSimilarity)} | ${s.ok >= MIN_SUCCESSES ? 'yes' : `no (< ${MIN_SUCCESSES} successes)`} |`,
      );
    }
    out.push('');
  }

  const errors = rows.flatMap((row) =>
    row.requests
      .filter((r) => !r.ok)
      .map((r) => ({ row: row.id, sample: r.sampleId, error: r.error })),
  );
  out.push('### Errors', '');
  if (errors.length === 0) {
    out.push('None.', '');
  } else {
    out.push('| Row | Sample | Error |', '|---|---|---|');
    for (const e of errors)
      out.push(`| ${e.row} | ${e.sample} | ${(e.error ?? '').replace(/\|/g, '\\|')} |`);
    out.push('');
  }
  return out.join('\n');
}

if (require.main === module) {
  const path = process.argv[2] ?? newestResults();
  const results = JSON.parse(readFileSync(path, 'utf8')) as BenchResults;
  console.log(renderReport(results));
}
