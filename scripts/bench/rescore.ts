// npm run bench:rescore -- <results.json> — recomputes exact / exactLoose / similarity of every
// successful request from its saved raw output with the current scoring rules. bench.ts calls
// rescoreResults() before every save, so a results file never mixes scoring versions.
import { readFileSync, writeFileSync } from 'node:fs';
import type { BenchResults } from './results';
import { loadSamples, type BenchSample } from './samples';
import { scoreCompletion, SCORING_VERSION } from './stats';

export function rescoreResults(results: BenchResults, samples: readonly BenchSample[]): void {
  const expected = new Map(samples.map((s) => [s.id, s.expected]));
  for (const row of Object.values(results.rows)) {
    for (const request of row.requests) {
      if (!request.ok) continue;
      const target = expected.get(request.sampleId);
      if (target === undefined) {
        throw new Error(`unknown sample ${request.sampleId} in row ${row.id}`);
      }
      const score = scoreCompletion(request.output, target);
      request.cleaned = score.cleaned;
      request.exact = score.exact;
      request.exactLoose = score.exactLoose;
      request.similarity = score.similarity;
      if (request.processed !== undefined) {
        request.exactProcessed = scoreCompletion(request.processed, target).exact;
      }
    }
  }
  results.scoringVersion = SCORING_VERSION;
}

if (require.main === module) {
  const path = process.argv[2];
  if (!path) throw new Error('usage: npm run bench:rescore -- <results.json>');
  const results = JSON.parse(readFileSync(path, 'utf8')) as BenchResults;
  rescoreResults(results, loadSamples());
  writeFileSync(path, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`rescored ${path} with scoring version ${SCORING_VERSION}`);
}
