// Backend contract shared by every feature (PLAN §4). Frozen at the end of Faz 1 Loop A: the
// Codex-built backends (ollama.ts, openaiCompat.ts — PLAN §12) implement it as-is; any change needs
// the user's approval first (AGENTS.md).
//
// Rules for every implementation:
// - No `vscode` import. Configuration comes in through the constructor (docs/plans/phase-1.md D3),
//   so the bench and vitest can drive the production code outside VS Code.
// - When `signal` aborts, stop the work and release every process / HTTP request it holds, then
//   reject (or end the iterable) promptly.
// - Never execute model output; return it as text only (AGENTS.md rule 2).

export type BackendId = 'claude-cli' | 'codex-cli' | 'ollama' | 'openai-compat';

export interface CompletionRequest {
  prefix: string;
  suffix: string;
  languageId: string;
  filePath: string;
  snippets: { path: string; text: string }[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface RunOptions {
  system?: string;
  signal: AbortSignal;
}

export interface Backend {
  id: BackendId;
  kind: 'fim' | 'chat';
  /** CLI installed / server reachable. Must not throw. */
  isAvailable(): Promise<boolean>;
  /** Raw completion text for the hole between prefix and suffix (post-processing is the caller's). */
  complete(req: CompletionRequest): Promise<string>;
  /** Streams a chat answer (used by the chat provider, Faz 2). */
  run(prompt: string, opts: RunOptions): AsyncIterable<string>;
  /** Releases processes, pools and connections. */
  dispose(): void;
}
