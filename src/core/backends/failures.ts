// Classified CLI failures with fixed, actionable messages (docs/plans/phase-3-errors.md).
// The stream readers classify while they parse and keep only the kind: no CLI text leaves them,
// since it may quote the prompt (AGENTS rules 2 and 7, phase-1-local.md C6). The phrases come
// from real captures (test/fixtures/*/auth-failure.jsonl) and from the installed CLI binaries
// (docs/cli-notes.md, "Failures"; the limit and context phrases there are unverified).

export type CliFailureKind =
  'not-installed' | 'not-logged-in' | 'limit' | 'context' | 'timeout' | 'cancelled' | 'other';

export type CliName = 'claude' | 'codex';

// Claude Code 2.1.312 classifies its own errors with this list (in its binary); an invalid API key
// was captured (`api_error_status` 401). "You've hit your limit" is what it prints for a 429.
const CLAUDE_NOT_LOGGED_IN =
  /\b(?:not logged in|please run \/login|run \/login|authentication failed|invalid api key|oauth token (?:has )?(?:expired|revoked)|oauth refresh token is no longer valid)\b/i;
const CLAUDE_LIMIT =
  /\b(?:usage limit reached|you['’]ve hit your (?:usage )?limit|credit balance (?:is )?too low)\b/i;
// A prompt beyond the model's context (phase-4-hardening.md AC1): "Prompt is too long" (also as
// "prompt is too long: N tokens > M maximum"), "input is too long for requested model", "The model
// has reached its context window limit." From the binary, unverified.
const CLAUDE_CONTEXT =
  /\b(?:prompt is too long|input is too long for requested model|reached its context window limit)\b/i;

// codex-cli 0.164.0: a missing login was captured ("401 Unauthorized"); the limit phrases are
// from its binary ("You’ve hit your usage limit", "Usage limit reached", "You've reached your
// usage limit"), unverified.
const CODEX_NOT_LOGGED_IN = /\b(?:401 unauthorized|not logged in)\b/i;
const CODEX_LIMIT =
  /\b(?:usage limit reached|you['’]ve (?:hit|reached) your usage limit|429 too many requests)\b/i;
// "Codex ran out of room in the model's context window. …" and "context window exceeded", from the
// binary, unverified.
const CODEX_CONTEXT =
  /\b(?:ran out of room in the model['’]s context window|context window exceeded)\b/i;

/** A Codex `error` event that the CLI retries by itself ("Reconnecting... 2/5 (...)"). */
export const CODEX_RETRY = /^Reconnecting\.\.\. \d+\/\d+\b/;

/**
 * The kind of a failed Claude `result` event. `api_error_status` (the HTTP status) decides first;
 * otherwise the `result` text is compared with the fixed phrases; a top-level
 * `rate_limit_event` status `rejected` before the result means a limit.
 */
export function classifyClaudeResult(fields: {
  apiErrorStatus?: unknown;
  text?: unknown;
  rateLimitRejected?: boolean;
}): CliFailureKind {
  const status = fields.apiErrorStatus;
  if (status === 401 || status === 403) return 'not-logged-in';
  if (status === 429 || fields.rateLimitRejected === true) return 'limit';
  const text = typeof fields.text === 'string' ? fields.text : '';
  if (CLAUDE_NOT_LOGGED_IN.test(text)) return 'not-logged-in';
  if (CLAUDE_LIMIT.test(text)) return 'limit';
  if (CLAUDE_CONTEXT.test(text)) return 'context';
  return 'other';
}

/** The kind a Codex error message names, or undefined when it names none. */
export function classifyCodexMessage(text: string): CliFailureKind | undefined {
  if (CODEX_NOT_LOGGED_IN.test(text)) return 'not-logged-in';
  if (CODEX_LIMIT.test(text)) return 'limit';
  if (CODEX_CONTEXT.test(text)) return 'context';
  return undefined;
}

const LABEL: Record<CliName, string> = { claude: 'Claude Code CLI', codex: 'Codex CLI' };

/** The fixed message for a kind: what happened and what to do. */
export function failureMessage(cli: CliName, kind: CliFailureKind): string {
  const label = LABEL[cli];
  switch (kind) {
    case 'not-installed':
      return `The ${label} was not found. Install it, or set \`magipilot.${cli}.path\`.`;
    case 'not-logged-in':
      return cli === 'claude'
        ? 'The Claude Code CLI is not logged in. Run `claude` in a terminal and log in.'
        : 'The Codex CLI is not logged in. Run `codex login` in a terminal.';
    case 'limit':
      return cli === 'claude'
        ? 'Your Claude usage limit is reached. Magipilot pauses Claude requests for a few minutes; you can switch the backend.'
        : 'Your Codex usage limit is reached. Magipilot pauses Codex requests for a few minutes; you can switch the backend.';
    case 'context':
      return `The conversation is too long for the ${label}. Start a new chat, or attach less.`;
    case 'timeout':
      return `The ${label} did not answer in time.`;
    case 'cancelled':
      return `The ${label} request was cancelled.`;
    case 'other':
      return `The ${label} failed. See the log for details.`;
  }
}

/**
 * A classified CLI failure; its message is fixed per kind and CLI (never CLI output). `detail` is
 * fixed text too (`processFailure`'s `exit 3`, `timeout`, or `error result`, `no result`), for the
 * log only.
 */
export class CliFailure extends Error {
  constructor(
    readonly cli: CliName,
    readonly kind: CliFailureKind,
    readonly detail?: string,
  ) {
    super(failureMessage(cli, kind));
    this.name = 'CliFailure';
  }
}

const KINDS: ReadonlySet<string> = new Set<CliFailureKind>([
  'not-installed',
  'not-logged-in',
  'limit',
  'context',
  'timeout',
  'cancelled',
  'other',
]);

/**
 * Whether `err` is a `CliFailure`, by its shape rather than `instanceof`, so that a failure from
 * another bundle (a test's injected backend) is recognised too.
 */
export function isCliFailure(err: unknown): err is CliFailure {
  if (!(err instanceof Error) || err.name !== 'CliFailure') return false;
  const { cli, kind } = err as Partial<CliFailure>;
  return (cli === 'claude' || cli === 'codex') && typeof kind === 'string' && KINDS.has(kind);
}

/**
 * The kind of a finished CLI call (phase-3-errors §3 step 3): a timeout first; then a reader's
 * `not-logged-in`, `limit` or `context`, also when the process then exits non-zero; then `other` for a
 * non-zero exit, a reader failure without a match, or a missing result. Cancellation is handled
 * before this (it throws an AbortError). Undefined means success.
 */
export function failureKind(input: {
  timedOut: boolean;
  processFailed: boolean;
  readerKind?: CliFailureKind;
  readerFailed: boolean;
  hasResult: boolean;
}): CliFailureKind | undefined {
  if (input.timedOut) return 'timeout';
  if (
    input.readerKind === 'not-logged-in' ||
    input.readerKind === 'limit' ||
    input.readerKind === 'context'
  ) {
    return input.readerKind;
  }
  if (input.processFailed || input.readerFailed || !input.hasResult) return 'other';
  return undefined;
}
