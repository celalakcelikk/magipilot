import { describe, expect, it } from 'vitest';
import { parseVerifyArgs } from '../../scripts/lib/cli/verifyArgs';
import { evaluateInvariants, isExplicitNo } from '../../scripts/lib/cli/verifyInvariants';

function healthySummary(): Record<string, unknown> {
  return {
    help: { claudeMissingFlags: [], codexExecMissingFlags: [] },
    processes: { started: 20, leaked: 0 },
    checks: {
      E1_streamJsonWithoutVerbose: {
        exitCode: 1,
        stderrHead: 'Error: When using --print, --output-format=stream-json requires --verbose',
      },
      E2_toolsDisabled: {
        initToolsCount: 0,
        initMcpServersCount: 0,
        toolUseSeen: false,
        isError: false,
        exitCode: 0,
      },
      E3_projectClaudeMd: {
        controlWithoutSafeMode: { pineapple: true, isError: false, exitCode: 0 },
        withIsolation: { pineapple: false, isError: false, exitCode: 0 },
      },
      E4_userInstructions: {
        controlWithoutSafeMode: { textHead: 'No', isError: false, exitCode: 0 },
        withIsolation: { textHead: 'No', isError: false, exitCode: 0 },
      },
      E4b_promptOverhead: { isolated: { toolUseSeen: false, isError: false, exitCode: 0 } },
      E5_sessionPersistence: {
        withFlag: { ok: true, projectDirsAfter: 0 },
        withoutFlag: { ok: true, projectDirsAfter: 1 },
      },
      E6_effortLowWithHaiku: { accepted: true },
      E7_warmProcess: {
        textSilent: { ok: false },
        textNewline: { ok: true, exitCode: 0, timedOut: false },
        streamJson: {
          ok: true,
          exitCode: 0,
          timedOut: false,
          modelApiCallsBeforePrompt: 0,
          modelApiCallsTotal: 1,
        },
      },
      E8_codexStdinOpen: { stillRunningAfter10s: true },
      E9_codexProfiles: { leanIgnoreUserConfig: { exitCode: 0, text: 'OK', failed: false } },
      E10_models: {
        claude: {
          haiku: { isError: false, exitCode: 0, timedOut: false, model: 'claude-haiku-5-5' },
        },
        codexGpt61Sol: { exitCode: 0 },
      },
      E11_streamJsonSession: { exitCode: 0, turns: 2 },
      E12_nonessentialTrafficOptOut: {
        ok: true,
        exitCode: 0,
        timedOut: false,
        eventLoggingLinesTotal: 0,
        modelApiCallsTotal: 1,
      },
    },
  };
}

type Checks = Record<string, Record<string, Record<string, unknown>>>;

describe('cli:verify invariants (review P0-I008)', () => {
  it('passes a healthy run without warnings', () => {
    const report = evaluateInvariants(healthySummary());
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('fails when a relied-on flag disappears from --help', () => {
    const summary = healthySummary();
    summary.help = { claudeMissingFlags: ['--safe-mode'], codexExecMissingFlags: [] };
    expect(evaluateInvariants(summary).failures.join()).toContain('--safe-mode');
  });

  it('fails when no empirical check ran', () => {
    const report = evaluateInvariants({ help: healthySummary().help, processes: { leaked: 0 } });
    expect(report.failures.join()).toContain('no empirical checks ran');
  });

  it('fails on broken safety checks and leaks', () => {
    const summary = healthySummary();
    const checks = summary.checks as Record<string, Record<string, unknown>>;
    checks.E2_toolsDisabled!.toolUseSeen = true;
    (checks.E3_projectClaudeMd!.withIsolation as Record<string, unknown>).pineapple = true;
    (checks.E7_warmProcess!.streamJson as Record<string, unknown>).modelApiCallsBeforePrompt = 1;
    summary.processes = { leaked: 2 };
    const failures = evaluateInvariants(summary).failures.map((f) => f.split(':')[0]);
    expect(failures).toEqual(expect.arrayContaining(['E2', 'E3', 'E7', 'processes']));
  });

  it('never accepts missing evidence from failed calls (review P0-R2-002)', () => {
    const summary = healthySummary();
    const checks = summary.checks as Checks;
    // E3: the isolated call timed out — "no PINEAPPLE" proves nothing.
    checks.E3_projectClaudeMd!.withIsolation = { pineapple: false, isError: true, exitCode: null };
    // E5: the call with the flag failed, so "no session directory" proves nothing.
    checks.E5_sessionPersistence!.withFlag = { ok: false, projectDirsAfter: 0 };
    // E7: no API request is visible at all — the debug log was not captured or its format changed.
    checks.E7_warmProcess!.streamJson = {
      ok: true,
      modelApiCallsBeforePrompt: 0,
      modelApiCallsTotal: 0,
    };
    const failures = evaluateInvariants(summary).failures.map((f) => f.split(':')[0]);
    expect(failures).toEqual(expect.arrayContaining(['E3', 'E5', 'E7']));
  });

  it('accepts only an explicit "no" as E4 isolation evidence (review P0-R3-001)', () => {
    expect(isExplicitNo('no')).toBe(true);
    expect(isExplicitNo(' No. ')).toBe(true);
    expect(isExplicitNo('"No"')).toBe(true);
    expect(isExplicitNo('My context mentions RTK and graphify.')).toBe(false);
    expect(isExplicitNo('Yes')).toBe(false);
    expect(isExplicitNo("I can't tell")).toBe(false);
    expect(isExplicitNo('')).toBe(false);
    expect(isExplicitNo('No, but graphify is mentioned')).toBe(false);
    for (const answer of ['My context mentions RTK and graphify.', '', 'I cannot answer that.']) {
      const summary = healthySummary();
      const checks = summary.checks as Checks;
      checks.E4_userInstructions!.withIsolation = {
        textHead: answer,
        isError: false,
        exitCode: 0,
      };
      const failures = evaluateInvariants(summary).failures.map((f) => f.split(':')[0]);
      expect(failures, answer).toContain('E4');
    }
  });

  it('fails calls that returned a result but then timed out or exited non-zero (review P0-FINAL-001)', () => {
    const summary = healthySummary();
    const checks = summary.checks as Checks;
    // E10: Sonnet answered, then hung until the timeout killed it.
    (checks.E10_models!.claude as Record<string, unknown>).sonnet = {
      isError: false,
      exitCode: null,
      timedOut: true,
      model: 'claude-sonnet-5-5',
    };
    // E7: result event, but the warm process exited 1.
    checks.E7_warmProcess!.streamJson = {
      ok: true,
      exitCode: 1,
      timedOut: false,
      modelApiCallsBeforePrompt: 0,
      modelApiCallsTotal: 1,
    };
    // E12: result event, then a timeout. E2: result event, then a non-zero exit.
    const flat = summary.checks as Record<string, Record<string, unknown>>;
    flat.E12_nonessentialTrafficOptOut = {
      ok: true,
      exitCode: null,
      timedOut: true,
      eventLoggingLinesTotal: 0,
      modelApiCallsTotal: 1,
    };
    flat.E2_toolsDisabled!.exitCode = 1;
    const failures = evaluateInvariants(summary).failures.map((f) => f.split(':')[0]);
    expect(failures).toEqual(expect.arrayContaining(['E10/sonnet', 'E7', 'E12', 'E2']));
  });

  it('only warns when a negative control comes out unexpectedly', () => {
    const summary = healthySummary();
    const checks = summary.checks as Record<string, Record<string, unknown>>;
    (checks.E3_projectClaudeMd!.controlWithoutSafeMode as Record<string, unknown>).pineapple =
      false;
    const report = evaluateInvariants(summary);
    expect(report.failures).toEqual([]);
    expect(report.warnings.join()).toContain('E3-control');
  });
});

describe('parseVerifyArgs (inspection P3E-I003)', () => {
  it('runs the full suite only without arguments', () => {
    expect(parseVerifyArgs([])).toEqual({});
  });
  it('accepts --only auth and --only=auth', () => {
    expect(parseVerifyArgs(['--only', 'auth'])).toEqual({ only: 'auth' });
    expect(parseVerifyArgs(['--only=auth'])).toEqual({ only: 'auth' });
    expect(parseVerifyArgs(['--only', 'models'])).toEqual({ only: 'models' });
  });
  it('accepts --only structured (phase-4-tools.md AC8)', () => {
    expect(parseVerifyArgs(['--only', 'structured'])).toEqual({ only: 'structured' });
    expect(() => parseVerifyArgs(['--only', 'struct'])).toThrow();
  });
  it('refuses a missing or unknown selector, a single "--only aut" word and any other argument', () => {
    for (const args of [
      ['--only'],
      ['--only', 'aut'],
      ['--only aut'],
      ['--only=aut'],
      ['--onlyauth'],
      ['auth'],
      ['--verbose'],
    ]) {
      expect(() => parseVerifyArgs(args), JSON.stringify(args)).toThrow();
    }
  });
});

describe('S1: structured output (phase-4-tools.md AC8)', () => {
  const s1 = (claude: Record<string, unknown>, codex: Record<string, unknown>) => ({
    only: 'structured',
    help: { claudeMissingFlags: [], codexExecMissingFlags: [] },
    checks: { S1_structuredOutput: { claude, codex } },
    processes: { leaked: 0 },
  });
  const goodClaude = {
    isError: false,
    exitCode: 0,
    initTools: ['StructuredOutput'],
    initListCounts: { mcp_servers: 0 },
    envelope: { valid: true, toolCalls: ['read_file'] },
  };
  const goodCodex = { exitCode: 0, envelope: { valid: true, toolCalls: ['read_file'] } };

  it('passes with only StructuredOutput offered and both envelopes valid', () => {
    const report = evaluateInvariants(s1(goodClaude, goodCodex));
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('fails when Claude offers another tool, an MCP server, or an answer is not the envelope', () => {
    expect(
      evaluateInvariants(
        s1({ ...goodClaude, initTools: ['StructuredOutput', 'Bash'] }, goodCodex),
      ).failures.join(),
    ).toContain('S1-claude-tools');
    expect(
      evaluateInvariants(
        s1({ ...goodClaude, initListCounts: { mcp_servers: 1 } }, goodCodex),
      ).failures.join(),
    ).toContain('S1-claude-mcp');
    expect(
      evaluateInvariants(
        s1(goodClaude, { ...goodCodex, envelope: { valid: false } }),
      ).failures.join(),
    ).toContain('S1-codex');
  });

  it('only warns when a model answers without the expected call', () => {
    const report = evaluateInvariants(
      s1(goodClaude, { ...goodCodex, envelope: { valid: true, toolCalls: [] } }),
    );
    expect(report.failures).toEqual([]);
    expect(report.warnings.join()).toContain('S1-codex-call');
  });
});

describe('M1: the model lists (inspection P4M-I005)', () => {
  const healthy = () => ({
    only: 'models',
    processes: { leaked: 0 },
    checks: {
      M1_models: {
        claude: { count: 3 },
        codex: { count: 8 },
        claudeRawProbe: { eventTypes: ['control_response/'], exitCode: 0, timedOut: false },
        pass: true,
      },
    },
  });
  const failed = (change: (m1: Record<string, unknown>) => void): string[] => {
    const summary = healthy();
    change(summary.checks.M1_models);
    return evaluateInvariants(summary).failures.map((f) => f.split(':')[0]!);
  };

  it('passes a healthy run', () => {
    expect(evaluateInvariants(healthy()).failures).toEqual([]);
  });

  it('fails malformed output, a missing answer, a failed exit, a model call and pass false', () => {
    expect(
      failed(
        (m) => (m.claudeRawProbe = { eventTypes: ['non-json'], exitCode: 0, timedOut: false }),
      ),
    ).toContain('M1-initialize');
    expect(
      failed((m) => (m.claudeRawProbe = { eventTypes: [], exitCode: 0, timedOut: false })),
    ).toContain('M1-initialize');
    expect(
      failed(
        (m) =>
          (m.claudeRawProbe = { eventTypes: ['control_response/'], exitCode: 1, timedOut: false }),
      ),
    ).toContain('M1-initialize');
    expect(
      failed(
        (m) =>
          (m.claudeRawProbe = {
            eventTypes: ['control_response/'],
            exitCode: null,
            timedOut: true,
          }),
      ),
    ).toContain('M1-initialize');
    expect(
      failed(
        (m) =>
          (m.claudeRawProbe = {
            eventTypes: ['control_response/', 'result/success'],
            exitCode: 0,
            timedOut: false,
          }),
      ),
    ).toContain('M1-no-model-call');
    expect(failed((m) => (m.pass = false))).toContain('M1-pass');
    expect(failed((m) => (m.codex = { failure: 'exit' }))).toContain('M1-codex');
  });
});

describe('W1: the windows (phase-4-context.md)', () => {
  const healthy = () => ({
    only: 'models',
    processes: { leaked: 0 },
    checks: {
      W1_windows: {
        windows: { opus: 1_000_000, sonnet: 1_000_000, 'claude-opus-4-6': 200_000 },
        rawProbe: {
          eventTypes: ['control_response/', 'control_response/'],
          exitCode: 0,
          timedOut: false,
        },
        pass: true,
      },
    },
  });
  const failed = (change: (w1: Record<string, unknown>) => void): string[] => {
    const summary = healthy();
    change(summary.checks.W1_windows);
    return evaluateInvariants(summary).failures.map((f) => f.split(':')[0]!);
  };

  it('passes a healthy run', () => {
    expect(evaluateInvariants(healthy()).failures).toEqual([]);
  });

  it('fails a missing or bad window, a missing answer, a failed exit, a model call and pass false', () => {
    expect(
      failed((w) => (w.windows = { opus: 'timeout', sonnet: 1_000_000, x: 200_000 })),
    ).toContain('W1-windows');
    expect(failed((w) => (w.windows = { opus: 1_000, sonnet: 1_000_000, x: 200_000 }))).toContain(
      'W1-windows',
    );
    expect(failed((w) => (w.windows = { opus: 1_000_000 }))).toContain('W1-windows');
    expect(
      failed(
        (w) => (w.rawProbe = { eventTypes: ['control_response/'], exitCode: 0, timedOut: false }),
      ),
    ).toContain('W1-answer');
    expect(
      failed(
        (w) =>
          (w.rawProbe = {
            eventTypes: ['control_response/', 'control_response/'],
            exitCode: 1,
            timedOut: false,
          }),
      ),
    ).toContain('W1-answer');
    expect(
      failed(
        (w) =>
          (w.rawProbe = {
            eventTypes: ['control_response/', 'control_response/', 'assistant/'],
            exitCode: 0,
            timedOut: false,
          }),
      ),
    ).toContain('W1-no-model-call');
    expect(failed((w) => (w.pass = false))).toContain('W1-pass');
  });
});
