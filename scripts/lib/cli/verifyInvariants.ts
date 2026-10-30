// Pass/fail rules for `npm run cli:verify` (review P0-I008). Safety and contract checks fail the
// run (exit 1); negative controls that come out unexpectedly only warn, because they make a
// check inconclusive rather than unsafe.

export interface InvariantReport {
  failures: string[];
  warnings: string[];
  passed: string[];
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {};
}

/** A summarized Claude call that produced a successful result event (cli-verify summarizeClaude). */
function completed(call: Json): boolean {
  // A result event alone is not enough: the process must also exit 0 without being timed out or
  // killed (review P0-FINAL-001, same rule as the bench's classifyProcessAttempt).
  return call.isError === false && call.exitCode === 0 && call.timedOut !== true;
}

/** A warm-process summary (cli-verify warm()): successful result and a clean exit. */
function completedWarm(call: Json): boolean {
  return call.ok === true && call.exitCode === 0 && call.timedOut !== true && call.aborted !== true;
}

/**
 * The E4 question asks for "yes" or "no" only. Isolation is proven solely by an explicit "no";
 * an affirmative answer, a refusal or an empty reply proves nothing (review P0-R3-001).
 */
export function isExplicitNo(answer: string): boolean {
  return /^no[.!]?$/i.test(answer.trim().replace(/^["'`*]+|["'`*]+$/g, ''));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function evaluateInvariants(summary: Json): InvariantReport {
  const report: InvariantReport = { failures: [], warnings: [], passed: [] };
  const must = (id: string, ok: boolean, detail: string): void => {
    (ok ? report.passed : report.failures).push(`${id}: ${detail}`);
  };
  const should = (id: string, ok: boolean, detail: string): void => {
    (ok ? report.passed : report.warnings).push(`${id}: ${detail}`);
  };

  const help = obj(summary.help);
  const missing = [
    ...((help.claudeMissingFlags as string[] | undefined) ?? []),
    ...((help.codexExecMissingFlags as string[] | undefined) ?? []),
  ];
  must(
    'help',
    missing.length === 0,
    `relied-on flags missing from --help: [${missing.join(', ')}]`,
  );

  const checks = obj(summary.checks);
  if (Object.keys(checks).length === 0) {
    must('checks', false, 'no empirical checks ran');
    return report;
  }

  // A1: authentication failures are captured credential-isolated (phase-3-errors §3 step 1).
  const auth = obj(checks.A1_authFailure);
  if (Object.keys(auth).length > 0) {
    const claude = obj(auth.claude);
    must(
      'A1-claude',
      claude.succeeded === false && claude.failureKind === 'not-logged-in',
      `--bare with an invalid key fails as not-logged-in (got ${String(claude.failureKind)})`,
    );
    const codex = obj(auth.codex);
    must('A1-codex-gate', codex.gateNotLoggedIn === true, 'codex login status: not logged in');
    must(
      'A1-codex',
      codex.succeeded === false && codex.failureKind === 'not-logged-in',
      `an empty CODEX_HOME fails as not-logged-in (got ${String(codex.failureKind)})`,
    );
  }
  if (summary.only === 'auth') return report;

  const m1 = obj(checks.M1_models);
  if (Object.keys(m1).length > 0) {
    const raw = obj(m1.claudeRawProbe);
    const types = Array.isArray(raw.eventTypes) ? (raw.eventTypes as unknown[]).map(String) : [];
    must(
      'M1-claude',
      obj(m1.claude).count !== undefined,
      'Claude Code answered initialize with models',
    );
    must('M1-codex', obj(m1.codex).count !== undefined, 'codex debug models listed models');
    must(
      'M1-initialize',
      types.includes('control_response/') && raw.exitCode === 0 && raw.timedOut === false,
      `the raw Claude probe got the initialize answer and exited 0 (events: ${types.join(', ')}; exit ${String(raw.exitCode)})`,
    );
    must(
      'M1-no-model-call',
      types.length > 0 && !types.some((type) => /^(assistant|result)\//.test(type)),
      `the Claude probe made no model call (events: ${types.join(', ')})`,
    );
    must('M1-pass', m1.pass === true, 'every M1 condition held (models, answer, no model call)');
  }
  // W1 (phase-4-context.md): Claude's window per model, without a model call.
  const w1 = obj(checks.W1_windows);
  if (Object.keys(w1).length > 0) {
    const raw = obj(w1.rawProbe);
    const types = Array.isArray(raw.eventTypes) ? (raw.eventTypes as unknown[]).map(String) : [];
    const windows = Object.entries(obj(w1.windows));
    must(
      'W1-windows',
      windows.length > 2 &&
        windows.every(
          ([, window]) =>
            typeof window === 'number' &&
            Number.isInteger(window) &&
            window >= 64_000 &&
            window <= 2_000_000,
        ),
      `every model's window was read (${windows.map(([id, w]) => `${id}=${String(w)}`).join(', ')})`,
    );
    must(
      'W1-answer',
      types.filter((type) => type === 'control_response/').length === 2 &&
        raw.exitCode === 0 &&
        raw.timedOut === false,
      `the raw window probe got both answers and exited 0 (events: ${types.join(', ')}; exit ${String(raw.exitCode)})`,
    );
    must(
      'W1-no-model-call',
      types.length > 0 && !types.some((type) => /^(assistant|result)\//.test(type)),
      `the window probe made no model call (events: ${types.join(', ')})`,
    );
    must('W1-pass', w1.pass === true, 'every W1 condition held (windows, answers, no model call)');
  }
  if (summary.only === 'models') {
    must('processes', obj(summary.processes).leaked === 0, 'no process outlives the run');
    return report;
  }

  const s1 = obj(checks.S1_structuredOutput);
  if (Object.keys(s1).length > 0) {
    const claude = obj(s1.claude);
    const tools = Array.isArray(claude.initTools) ? (claude.initTools as unknown[]) : undefined;
    must(
      'S1-claude-tools',
      tools !== undefined && tools.length === 1 && tools[0] === 'StructuredOutput',
      `--json-schema offers only StructuredOutput (got [${(tools ?? []).join(', ')}])`,
    );
    must(
      'S1-claude-mcp',
      obj(claude.initListCounts).mcp_servers === 0,
      'no MCP server with --json-schema',
    );
    must(
      'S1-claude',
      completed(claude) && obj(claude.envelope).valid === true,
      'the answer is the envelope (structured_output)',
    );
    const codex = obj(s1.codex);
    must(
      'S1-codex',
      codex.exitCode === 0 && codex.timedOut !== true && obj(codex.envelope).valid === true,
      'the last message is the envelope (--output-schema)',
    );
    for (const [id, call] of [
      ['S1-claude-call', claude],
      ['S1-codex-call', codex],
    ] as const) {
      const calls = obj(call.envelope).toolCalls;
      should(
        id,
        Array.isArray(calls) && calls.includes('read_file'),
        'the model requested read_file through tool_calls',
      );
    }
  }
  if (summary.only === 'structured') {
    must('processes', obj(summary.processes).leaked === 0, 'no process outlives the run');
    return report;
  }

  const e1 = obj(checks.E1_streamJsonWithoutVerbose);
  must(
    'E1',
    e1.exitCode !== 0 && text(e1.stderrHead).includes('requires --verbose'),
    'stream-json without --verbose must fail with the "requires --verbose" error',
  );

  const e2 = obj(checks.E2_toolsDisabled);
  must(
    'E2',
    completed(e2) &&
      e2.initToolsCount === 0 &&
      e2.initMcpServersCount === 0 &&
      e2.toolUseSeen === false,
    'isolated run offers no tools and no MCP servers and makes no tool call',
  );

  // An observation only counts when the call itself completed (review P0-R2-002): a failed or
  // timed-out call says nothing about what the model would have seen.
  const e3 = obj(checks.E3_projectClaudeMd);
  const e3Isolated = obj(e3.withIsolation);
  must(
    'E3',
    completed(e3Isolated) && e3Isolated.pineapple === false,
    'a completed isolated run ignores a project CLAUDE.md',
  );
  should(
    'E3-control',
    completed(obj(e3.controlWithoutSafeMode)) && obj(e3.controlWithoutSafeMode).pineapple === true,
    'without --safe-mode the planted CLAUDE.md is obeyed (otherwise E3 is inconclusive)',
  );

  const e4 = obj(checks.E4_userInstructions);
  must(
    'E4',
    completed(obj(e4.withIsolation)) && isExplicitNo(text(obj(e4.withIsolation).textHead)),
    'a completed isolated run answers an explicit "no": it does not see the user-level CLAUDE.md (any other answer is a failure or inconclusive)',
  );
  // A sensitive control would need --setting-sources user, which loads the user's hooks and
  // tools; it is not run (review P0-I001). This variant documents the second barrier instead.
  should(
    'E4-settings-off',
    completed(obj(e4.controlWithoutSafeMode)) &&
      isExplicitNo(text(obj(e4.controlWithoutSafeMode).textHead)),
    'with user settings off the user-level CLAUDE.md stays hidden even without --safe-mode',
  );

  for (const [name, variant] of Object.entries(obj(checks.E4b_promptOverhead))) {
    const v = obj(variant);
    must(`E4b/${name}`, completed(v) && v.toolUseSeen === false, 'completed, no tool call');
  }

  const e5 = obj(checks.E5_sessionPersistence);
  must(
    'E5',
    obj(e5.withFlag).ok === true && obj(e5.withFlag).projectDirsAfter === 0,
    'a successful run with --no-session-persistence leaves no session directory',
  );
  should(
    'E5-control',
    obj(e5.withoutFlag).ok === true && Number(obj(e5.withoutFlag).projectDirsAfter) >= 1,
    'without the flag a session directory is created',
  );

  must('E6', obj(checks.E6_effortLowWithHaiku).accepted === true, '--effort low is accepted');

  // "0 calls before the prompt" only means something if the debug log was captured and the API
  // pattern still matches: the one call after the prompt must be visible (review P0-R2-002).
  const e7 = obj(checks.E7_warmProcess);
  const stream = obj(e7.streamJson);
  must(
    'E7',
    completedWarm(stream) &&
      Number(stream.modelApiCallsTotal) >= 1 &&
      stream.modelApiCallsBeforePrompt === 0,
    'an idle stream-json warm process answers after 20 s; its debug log shows the post-prompt model call and none before it',
  );
  should(
    'E7-text-silent',
    obj(e7.textSilent).ok === false,
    '-p text mode still gives up without stdin data',
  );
  should(
    'E7-text-newline',
    completedWarm(obj(e7.textNewline)),
    'a leading newline keeps text mode waiting',
  );

  should(
    'E8',
    obj(checks.E8_codexStdinOpen).stillRunningAfter10s === true,
    'Codex still waits while stdin is open (AGENTS.md rule)',
  );

  const e9 = obj(obj(checks.E9_codexProfiles).leanIgnoreUserConfig);
  must(
    'E9',
    e9.exitCode === 0 && text(e9.text).trim() !== '' && e9.failed === false,
    'the production Codex profile completes',
  );

  const e10 = obj(checks.E10_models);
  for (const [alias, result] of Object.entries(obj(e10.claude))) {
    const r = obj(result);
    must(
      `E10/${alias}`,
      completed(r) && text(r.model).startsWith('claude-'),
      'alias resolves, answers and the process exits cleanly',
    );
  }
  must('E10/codex', obj(e10.codexGpt61Sol).exitCode === 0, 'gpt-6.1-sol answers');

  const e11 = obj(checks.E11_streamJsonSession);
  must('E11', e11.exitCode === 0 && e11.turns === 2, 'a stream-json session answers two turns');

  const e12 = obj(checks.E12_nonessentialTrafficOptOut);
  must(
    'E12',
    completedWarm(e12),
    'the opt-out environment variable does not break requests (result and clean exit)',
  );
  should(
    'E12-telemetry',
    Number(e12.modelApiCallsTotal) >= 1 && e12.eventLoggingLinesTotal === 0,
    'no event logging with the opt-out (debug log captured: the model call is visible)',
  );

  must('processes', obj(summary.processes).leaked === 0, 'no process outlives the run');
  return report;
}
