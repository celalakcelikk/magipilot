#!/usr/bin/env node
// Fake `claude` / `codex` executable for unit, integration and smoke tests. It speaks just enough
// of the real output formats (test/fixtures/claude, test/fixtures/codex). Never calls any API.
//   FAKE_CLI_MODE  ok (default) | hang | exit-after-result | error-result | fail-turn | auth | limit
//                  | context
//                  auth: replays the real auth-failure capture (../claude, ../codex) and exits 1;
//                  limit: a usage-limit failure (phrases from the CLI binaries, docs/cli-notes.md);
//                  context: a context overflow (phrases from the CLI binaries, unverified)
//                  and exit 1 (phase-3-errors)
//   FAKE_CLI_TEXT  answer text (default "a + b;")
//   FAKE_CLI_LOG   file that receives JSON lines per invocation (argv, cwd, stdin facts: length,
//                  SHA-256, markers; never the text)
//   FAKE_CLI_MARKER  text echoed into stderr, the Claude error-result subtype and the Codex
//                    error message (tests that errors never carry CLI text)
//   FAKE_CLI_MODELS  set: `codex debug models` and Claude's `initialize` answer with the real lists
//                    (../codex/models.json, ../claude/models.json); unset: with empty lists
//   FAKE_CLI_PRIVACY_LIST  set: with CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, Claude's
//                    `initialize` answers with the privacy list (../claude/models-privacy.json)
//   FAKE_CLI_WINDOWS  JSON object, model → `rawMaxTokens` of the `get_context_usage` answer
//                    (../claude/context-usage.json); default: 1 000 000 for the 5.x aliases and
//                    claude-opus-4-8, 200 000 otherwise, as measured (phase-4-context.md §1)
//   FAKE_CLI_STRUCTURED  with --json-schema / --output-schema (tool calling): the answer, raw
//                    (default: the envelope with FAKE_CLI_TEXT and no tool call). Claude gets it as
//                    `structured_output` (parsed when it is JSON), Codex as its last message
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
// FAKE_CLI_MODE_FILE (smoke test): the mode is re-read when a request arrives, so a test can
// switch already running spare processes to "hang".
function currentMode() {
  const file = process.env.FAKE_CLI_MODE_FILE;
  if (file && existsSync(file)) return readFileSync(file, 'utf8').trim();
  return process.env.FAKE_CLI_MODE ?? 'ok';
}
const text = process.env.FAKE_CLI_TEXT ?? 'a + b;';
const isCodex = args[0] === 'exec';
const streamInput = args.includes('--input-format');
const structured = args.includes('--json-schema') || args.includes('--output-schema');
const structuredRaw =
  process.env.FAKE_CLI_STRUCTURED ?? JSON.stringify({ message: text, tool_calls: [] });
function structuredValue() {
  try {
    return JSON.parse(structuredRaw);
  } catch {
    return structuredRaw;
  }
}
/** The --output-schema file: whether it exists, and whether it lies inside the agent's cwd. */
function schemaFacts() {
  const at = args.indexOf('--output-schema');
  if (at < 0) return {};
  const file = args[at + 1];
  return { schemaExists: existsSync(file), schemaInCwd: file.startsWith(`${process.cwd()}/`) };
}

let stdin = '';
let stdinEnded = false;
let answered = false;
let initialized = false;
let windowAnswered = false;

function fixture(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

if (args[0] === '--version') {
  log({ version: true });
  console.log('0.0.0 (fake)');
  process.exit(0);
}

// `codex debug models` (phase-4-models.md): the catalog, or an empty one.
if (args[0] === 'debug' && args[1] === 'models') {
  if (currentMode() === 'hang') {
    log({ catalog: true, hung: true });
    setInterval(() => {}, 1000);
  } else {
    const catalog = process.env.FAKE_CLI_MODELS ? fixture('../codex/models.json') : { models: [] };
    // Pretty-printed like the real catalog, so the reader must join lines.
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    log({ catalog: true });
    process.exit(0);
  }
}

/** Claude's SDK `initialize` answer: the models, beside an account block that must be ignored. */
function answerInitialize() {
  initialized = true;
  const privacy =
    process.env.FAKE_CLI_PRIVACY_LIST && process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1';
  const models = process.env.FAKE_CLI_MODELS
    ? fixture(privacy ? '../claude/models-privacy.json' : '../claude/models.json')
    : [];
  emit({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'magipilot-models',
      response: { models, account: { email: 'not-a-real-account@example.invalid' }, commands: [] },
    },
  });
  log({ initialized: true, nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null });
}

/** Claude's `get_context_usage` answer for the `--model` of this process (phase-4-context.md W1). */
function answerContextUsage() {
  windowAnswered = true;
  const at = args.indexOf('--model');
  const model = at >= 0 ? args[at + 1] : 'default';
  const measured = ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-4-8'].includes(model)
    ? 1_000_000
    : 200_000;
  let windows = {};
  try {
    windows = JSON.parse(process.env.FAKE_CLI_WINDOWS ?? '{}');
  } catch {
    windows = {};
  }
  const answer = fixture('../claude/context-usage.json');
  answer.response.response.rawMaxTokens = model in windows ? windows[model] : measured;
  answer.response.response.model = model;
  emit(answer);
  log({ windowAsked: model, nonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null });
}

// FAKE_CLI_STDIN_MARKERS: comma-separated strings; the log reports which of them stdin contains.
function log(extra) {
  if (!process.env.FAKE_CLI_LOG) return;
  const markers = (process.env.FAKE_CLI_STDIN_MARKERS ?? '').split(',').filter(Boolean);
  const stdinMarkers = Object.fromEntries(markers.map((marker) => [marker, stdin.includes(marker)]));
  const entry = { pid: process.pid, args, cwd: process.cwd(), cwdEntries: readdirSync('.'), stdinEnded, stdinChars: stdin.length, stdinSha256: createHash('sha256').update(stdin).digest('hex'), stdinMarkers, mode: currentMode(), ...schemaFacts(), ...extra };
  appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(entry)}\n`);
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Replays a real capture line by line, then exits 1 like the CLI did. */
function replay(fixture) {
  const lines = readFileSync(new URL(fixture, import.meta.url), 'utf8').split('\n').filter(Boolean);
  for (const line of lines) process.stdout.write(`${line}\n`);
  log({ answered: true });
  process.exit(1);
}

function answerClaude() {
  answered = true;
  if (currentMode() === 'auth') replay('../claude/auth-failure.jsonl');
  if (currentMode() === 'limit') {
    emit({ type: 'system', subtype: 'init', model: 'fake-haiku', tools: [], mcp_servers: [] });
    emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
    emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your limit" });
    log({ answered: true });
    process.exit(1);
  }
  if (currentMode() === 'context') {
    emit({ type: 'system', subtype: 'init', model: 'fake-haiku', tools: [], mcp_servers: [] });
    emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 400, result: 'Prompt is too long: 250000 tokens > 200000 maximum' });
    log({ answered: true });
    process.exit(1);
  }
  if (structured) {
    // As Claude Code 2.1.312 with --json-schema: one internal tool, the answer as its input.
    emit({ type: 'system', subtype: 'init', model: 'fake-haiku', tools: ['StructuredOutput'], mcp_servers: [] });
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_fake', name: 'StructuredOutput', input: structuredValue() }] } });
    const isError = currentMode() === 'error-result';
    emit({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: structuredRaw, structured_output: structuredValue(), usage: { input_tokens: 10, output_tokens: 3 } });
    log({ answered: true });
    return;
  }
  emit({ type: 'system', subtype: 'init', model: 'fake-haiku', tools: [], mcp_servers: [] });
  if (args.includes('--include-partial-messages')) {
    for (const chunk of [text.slice(0, 2), text.slice(2)]) {
      if (chunk === '') continue;
      emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: chunk } } });
    }
  }
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const isError = currentMode() === 'error-result';
  const marker = process.env.FAKE_CLI_MARKER;
  const subtype = isError ? (marker ?? 'error_during_execution') : 'success';
  emit({ type: 'result', subtype, is_error: isError, usage: { input_tokens: 10, output_tokens: 3 } });
  log({ answered: true });
  if (currentMode() === 'exit-after-result') {
    if (marker) process.stderr.write(`${marker}\n`);
    process.exit(3);
  }
}

function answerCodex() {
  answered = true;
  if (currentMode() === 'auth') replay('../codex/auth-failure.jsonl');
  if (currentMode() === 'limit') {
    emit({ type: 'thread.started', thread_id: 'fake-thread' });
    emit({ type: 'turn.started' });
    emit({ type: 'turn.failed', error: { message: 'You\u2019ve hit your usage limit. Upgrade to Plus to continue using Codex.' } });
    log({ answered: true });
    process.exit(1);
  }
  if (currentMode() === 'context') {
    emit({ type: 'thread.started', thread_id: 'fake-thread' });
    emit({ type: 'turn.started' });
    emit({ type: 'turn.failed', error: { message: "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying." } });
    log({ answered: true });
    process.exit(1);
  }
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  emit({ type: 'turn.started' });
  if (currentMode() === 'fail-turn') {
    emit({ type: 'turn.failed', error: { message: process.env.FAKE_CLI_MARKER ?? 'fake failure' } });
    if (process.env.FAKE_CLI_MARKER) process.stderr.write(`${process.env.FAKE_CLI_MARKER}\n`);
    log({ answered: true });
    process.exit(1);
  }
  const answer = structured ? structuredRaw : text;
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } });
  const out = args.indexOf('-o');
  if (out >= 0) writeFileSync(args[out + 1], answer);
  log({ answered: true });
  if (currentMode() === 'exit-after-result') process.exit(3);
}

const keepAlive = setInterval(() => {}, 1000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
  if (answered) return;
  if (currentMode() === 'hang') {
    log({ answered: false, hung: true });
    answered = true; // never answers
    return;
  }
  if (!isCodex && streamInput && !initialized && stdin.includes('"subtype":"initialize"')) {
    answerInitialize();
  }
  if (
    !isCodex &&
    streamInput &&
    initialized &&
    !windowAnswered &&
    stdin.includes('"subtype":"get_context_usage"')
  ) {
    answerContextUsage();
  }
  if (!isCodex && streamInput && stdin.includes('"type":"user"')) answerClaude();
});
process.stdin.on('end', () => {
  stdinEnded = true;
  if (currentMode() === 'hang') {
    log({ answered: false });
    return; // keeps running after EOF, like a CLI busy with a request
  }
  if (!answered && !initialized) {
    if (isCodex) answerCodex();
    else answerClaude();
  }
  log({ event: 'stdin-end', userMessage: stdin.includes('"type":"user"') });
  // A valid initialize answer followed by a failed exit (inspection P4M-I003).
  if (initialized && currentMode() === 'exit-after-result') process.exit(3);
  clearInterval(keepAlive);
});
