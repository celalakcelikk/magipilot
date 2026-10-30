// P9 (docs/plans/phase-1.md): the post-processor on real model outputs recorded in Faz 0
// (test/fixtures/bench-data/2026-10-26.json), not only on hand-written cases.
import { describe, expect, it } from 'vitest';
import benchData from '../fixtures/bench-data/2026-10-26.json';
import phase1Run2 from '../fixtures/bench-data/2026-10-27-phase1-r2.json';
import { exactMatch } from '../../scripts/bench/stats';
import { loadSamples } from '../../scripts/bench/samples';
import { delimiterBalance } from '../../src/core/delimiters';
import { postprocess } from '../../src/core/postprocess';

interface RecordedRequest {
  sampleId: string;
  ok: boolean;
  output: string;
  exact?: boolean;
  exactLoose?: boolean;
}

const rows = (benchData as unknown as { rows: Record<string, { requests: RecordedRequest[] }> })
  .rows;
const samples = new Map(loadSamples().map((sample) => [sample.id, sample]));

function score(rowId: string): { strict: number; loose: number; processed: number } {
  let strict = 0;
  let loose = 0;
  let processed = 0;
  for (const request of rows[rowId]!.requests) {
    if (!request.ok) continue;
    const sample = samples.get(request.sampleId)!;
    if (request.exact) strict++;
    if (request.exactLoose) loose++;
    const result = postprocess(request.output, {
      prefix: sample.prefix,
      suffix: sample.suffix,
      maxLines: 8,
      languageId: sample.languageId,
    });
    if (exactMatch(result ?? '', sample.expected)) processed++;
  }
  return { strict, loose, processed };
}

describe('postprocess on real Faz 0 outputs', () => {
  it('fixes the haiku indentation habit: cold ≥ 12 and warm ≥ 10 strict exact matches', () => {
    expect(score('claude-haiku-cold').processed).toBeGreaterThanOrEqual(12);
    expect(score('claude-haiku-warm').processed).toBeGreaterThanOrEqual(10);
  });

  for (const rowId of Object.keys(rows)) {
    it(`${rowId}: never worse than the raw output, at least the "± indent" level`, () => {
      const { strict, loose, processed } = score(rowId);
      expect(processed).toBeGreaterThanOrEqual(strict);
      expect(processed).toBeGreaterThanOrEqual(loose);
    });
  }
});

describe('postprocess keeps recorded completions structurally intact (P1-I008)', () => {
  const allRows = {
    ...rows,
    ...(phase1Run2 as unknown as { rows: Record<string, { requests: RecordedRequest[] }> }).rows,
  };

  it('the event-emitter if block keeps its closing brace (prod-claude-cold, run 2)', () => {
    const sample = samples.get('06-event-emitter')!;
    const request = allRows['prod-claude-cold']!.requests.find((r) => r.sampleId === sample.id)!;
    const result = postprocess(request.output, {
      prefix: sample.prefix,
      suffix: sample.suffix,
      maxLines: 8,
      languageId: sample.languageId,
    });
    expect(result?.trimEnd().endsWith('}')).toBe(true);
    expect(delimiterBalance(sample.prefix + result + sample.suffix, sample.languageId)).toBe(0);
  });

  for (const [rowId, row] of Object.entries(allRows)) {
    it(`${rowId}: never unbalances a file that the raw output left balanced`, () => {
      for (const request of row.requests) {
        if (!request.ok || request.output.includes('```')) continue;
        const sample = samples.get(request.sampleId)!;
        if (
          delimiterBalance(sample.prefix + request.output + sample.suffix, sample.languageId) !== 0
        )
          continue;
        const result = postprocess(request.output, {
          prefix: sample.prefix,
          suffix: sample.suffix,
          maxLines: 8,
        });
        if (result === null) continue;
        expect(
          delimiterBalance(sample.prefix + result + sample.suffix, sample.languageId),
          `${rowId} ${request.sampleId}`,
        ).toBe(0);
      }
    });
  }
});

describe('postprocess never drops a statement the model only mis-indented (P1-I013)', () => {
  const sample = samples.get('13-http-handler')!;
  const recorded = (
    phase1Run2 as unknown as { rows: Record<string, { requests: RecordedRequest[] }> }
  ).rows;
  for (const rowId of ['prod-claude-warm', 'prod-claude-cold']) {
    it(`${rowId} / 13-http-handler keeps its return`, () => {
      const request = recorded[rowId]!.requests.find((r) => r.sampleId === sample.id)!;
      const result = postprocess(request.output, {
        prefix: sample.prefix,
        suffix: sample.suffix,
        maxLines: 8,
        languageId: sample.languageId,
      });
      expect(result?.trim().endsWith('return')).toBe(true);
    });
  }
});
