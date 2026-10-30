// Shape of the bench results file (.bench/results-*.json, test/fixtures/bench-data/*.json).

export interface RequestRecord {
  sampleId: string;
  /** 1-based position in the row (the turn number for the session row). */
  turn: number;
  ok: boolean;
  error?: string;
  totalMs?: number;
  firstTextMs?: number;
  initMs?: number;
  serverTtftMs?: number;
  usage?: Record<string, number>;
  output: string;
  cleaned?: string;
  exact?: boolean;
  /** Exact match ignoring leading whitespace (see stats.normalizeLoose). */
  exactLoose?: boolean;
  similarity?: number;
  /** Production rows only (Faz 1): the post-processed text and its strict exact match. */
  processed?: string;
  exactProcessed?: boolean;
  /** Production rows only: prompt written → result event; totalMs runs to complete() return. */
  resultMs?: number;
}

export interface RowResult {
  id: string;
  backend: string;
  mode: string;
  model: string;
  notes: string;
  startedAt: string;
  finishedAt: string;
  setupInfo?: Record<string, unknown>;
  requests: RequestRecord[];
}

export interface BenchResults {
  version: 1;
  startedAt: string;
  environment: {
    os: string;
    cpu: string;
    memoryGb: number;
    node: string;
    claude: string;
    codex: string;
    ollama: string;
  };
  settings: Record<string, unknown>;
  /** stats.SCORING_VERSION used for exact/exactLoose/similarity (absent = version 1). */
  scoringVersion?: number;
  sampleCount: number;
  rows: Record<string, RowResult>;
  /** One entry per `npm run bench` invocation that wrote this file. */
  runs?: {
    startedAt: string;
    rows: string[];
    processes: { started: number; leaked: number };
    note?: string;
  }[];
  /** Written by the first version of bench.ts (single run); superseded by `runs`. */
  processes?: { started: number; leaked: number };
}
