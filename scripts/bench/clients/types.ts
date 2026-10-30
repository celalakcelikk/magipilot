// Result shape shared by all bench clients.

export interface CompletionAttempt {
  ok: boolean;
  /** Short error class and message; never prompt content. */
  error?: string;
  /** Raw model output for the hole. */
  text: string;
  /** From the moment the request is sent until the completion is complete. */
  totalMs?: number;
  /** From the moment the request is sent until the first non-empty text arrives. */
  firstTextMs?: number;
  /** Claude only: process spawn → `system/init` event. */
  initMs?: number;
  /** Claude only: server-reported time to first token. */
  serverTtftMs?: number;
  /** Token counts as reported by the backend (names vary per backend). */
  usage?: Record<string, number>;
  /** Production rows only: the text after src/core/postprocess. */
  processed?: string;
  /** Production rows only: prompt written → result event (totalMs also includes the CLI exit). */
  resultMs?: number;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`.slice(0, 300);
  }
  return String(err).slice(0, 300);
}
