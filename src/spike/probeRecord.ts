// Pure helpers for the Faz 0 chat-provider probe (no `vscode` import, unit-tested).
// The probe embeds a marker in every request it triggers; the echo provider reads the marker
// back from the request so each provider call can be attributed to the action that caused it.

export const NONCE_PATTERN = /MPNONCE-[0-9a-f]{12}/g;

export function makeNonce(randomHex: (bytes: number) => string): string {
  return `MPNONCE-${randomHex(6)}`;
}

/**
 * Returns the last probe marker found in the request texts (in message order). Chat history
 * may still contain markers of earlier requests; the newest one belongs to this request.
 */
export function extractNonce(texts: readonly string[]): string | undefined {
  let last: string | undefined;
  for (const text of texts) {
    for (const match of text.matchAll(NONCE_PATTERN)) {
      last = match[0];
    }
  }
  return last;
}

export type ProbePhase = 'start' | 'complete' | 'cancelled' | 'error';

/** Metadata-only record of one provider call. It must never contain message content. */
export interface ProbeRecord {
  ts: string;
  phase: ProbePhase;
  requestNonce: string | null;
  modelId: string;
  messageCount: number;
  roles: string[];
  totalChars: number;
  toolsCount: number;
  /** Names of the tools VS Code offered (tool definitions, not message content). */
  toolNames: string[];
  toolMode: string;
  durationMs: number;
}

export interface ProbeRecordInput {
  phase: ProbePhase;
  requestNonce: string | undefined;
  modelId: string;
  roles: readonly string[];
  totalChars: number;
  toolNames: readonly string[];
  toolMode: string;
  startedAt: number;
  now: number;
}

export function buildProbeRecord(input: ProbeRecordInput): ProbeRecord {
  return {
    ts: new Date(input.now).toISOString(),
    phase: input.phase,
    requestNonce: input.requestNonce ?? null,
    modelId: input.modelId,
    messageCount: input.roles.length,
    roles: [...input.roles],
    totalChars: input.totalChars,
    toolsCount: input.toolNames.length,
    toolNames: [...input.toolNames],
    toolMode: input.toolMode,
    durationMs: input.now - input.startedAt,
  };
}

export interface StepExpectation {
  nonce: string;
  modelId: string;
  /** Phase that counts as success (default "complete"). */
  phase?: ProbePhase;
}

export interface StepMatch {
  passed: boolean;
  matched?: ProbeRecord;
  /** Records for this step's marker that do not satisfy it (wrong model or phase). */
  sameNonceOther: ProbeRecord[];
  /** Records carrying another marker or none (late requests of earlier actions, manual use). */
  foreign: number;
}

/** Judges one probe step: only a record carrying the step's own marker and model counts. */
export function matchStep(records: readonly ProbeRecord[], expected: StepExpectation): StepMatch {
  const phase = expected.phase ?? 'complete';
  const sameNonce = records.filter((r) => r.requestNonce === expected.nonce);
  const matched = sameNonce.find((r) => r.modelId === expected.modelId && r.phase === phase);
  return {
    passed: matched !== undefined,
    matched,
    sameNonceOther: sameNonce.filter((r) => r !== matched && r.phase !== 'start'),
    foreign: records.length - sameNonce.length,
  };
}

export function parseProbeLog(text: string): ProbeRecord[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ProbeRecord);
}
