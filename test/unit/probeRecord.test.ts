import { describe, expect, it } from 'vitest';
import {
  buildProbeRecord,
  extractNonce,
  makeNonce,
  matchStep,
  parseProbeLog,
  type ProbeRecord,
} from '../../src/spike/probeRecord';

const OLD = 'MPNONCE-aaaaaaaaaaaa';
const NEW = 'MPNONCE-bbbbbbbbbbbb';

function record(overrides: {
  requestNonce?: string;
  phase?: ProbeRecord['phase'];
  modelId?: string;
}): ProbeRecord {
  return buildProbeRecord({
    phase: overrides.phase ?? 'complete',
    requestNonce: overrides.requestNonce,
    modelId: overrides.modelId ?? 'magipilot-echo',
    roles: ['user'],
    totalChars: 10,
    toolNames: [],
    toolMode: 'Auto',
    startedAt: 0,
    now: 5,
  });
}

describe('probe markers', () => {
  it('makes markers in the expected format', () => {
    expect(makeNonce(() => '0123456789ab')).toBe('MPNONCE-0123456789ab');
  });

  it('extracts the newest marker of a request (history may contain older ones)', () => {
    expect(extractNonce([`earlier ${OLD}`, `now ${NEW}`])).toBe(NEW);
    expect(extractNonce([`${OLD} and ${NEW}`])).toBe(NEW);
    expect(extractNonce(['no marker here', 'MPNONCE-xyz'])).toBeUndefined();
  });
});

describe('buildProbeRecord', () => {
  it('contains metadata only — no message content field', () => {
    const r = buildProbeRecord({
      phase: 'start',
      requestNonce: NEW,
      modelId: 'magipilot-echo',
      roles: ['user', 'assistant', 'user'],
      totalChars: 42,
      toolNames: ['edit_file', 'read_file', 'search'],
      toolMode: 'Auto',
      startedAt: 1000,
      now: 1250,
    });
    expect(Object.keys(r).sort()).toEqual(
      [
        'durationMs',
        'messageCount',
        'modelId',
        'phase',
        'requestNonce',
        'roles',
        'toolMode',
        'toolNames',
        'toolsCount',
        'totalChars',
        'ts',
      ].sort(),
    );
    expect(r).toMatchObject({
      messageCount: 3,
      durationMs: 250,
      requestNonce: NEW,
      toolsCount: 3,
      toolNames: ['edit_file', 'read_file', 'search'],
    });
  });
});

describe('matchStep', () => {
  it('passes only for a complete record with the step marker and the expected model', () => {
    const records = [
      record({ requestNonce: NEW, phase: 'start' }),
      record({ requestNonce: NEW, phase: 'complete' }),
    ];
    const match = matchStep(records, { nonce: NEW, modelId: 'magipilot-echo' });
    expect(match.passed).toBe(true);
    expect(match.foreign).toBe(0);
  });

  it('does not count a record from the wrong model', () => {
    const records = [record({ requestNonce: NEW, modelId: 'magipilot-echo-tools' })];
    const match = matchStep(records, { nonce: NEW, modelId: 'magipilot-echo' });
    expect(match.passed).toBe(false);
    expect(match.sameNonceOther).toHaveLength(1);
  });

  it('regression: a late request of the previous action never satisfies the next step', () => {
    // The previous step's request reaches the provider only after the new step has begun.
    const records = [record({ requestNonce: OLD, phase: 'complete' })];
    const match = matchStep(records, { nonce: NEW, modelId: 'magipilot-echo' });
    expect(match.passed).toBe(false);
    expect(match.foreign).toBe(1);
  });

  it('does not count records without any marker (manual use)', () => {
    const match = matchStep([record({})], { nonce: NEW, modelId: 'magipilot-echo' });
    expect(match.passed).toBe(false);
  });

  it('can require the cancelled phase', () => {
    const records = [
      record({ requestNonce: NEW, phase: 'start', modelId: 'magipilot-echo-slow' }),
      record({ requestNonce: NEW, phase: 'cancelled', modelId: 'magipilot-echo-slow' }),
    ];
    expect(
      matchStep(records, { nonce: NEW, modelId: 'magipilot-echo-slow', phase: 'cancelled' }).passed,
    ).toBe(true);
    expect(matchStep(records, { nonce: NEW, modelId: 'magipilot-echo-slow' }).passed).toBe(false);
  });
});

describe('parseProbeLog', () => {
  it('parses JSONL and skips blank lines', () => {
    const text = `${JSON.stringify(record({ requestNonce: NEW }))}\n\n`;
    expect(parseProbeLog(text)).toHaveLength(1);
  });
});
