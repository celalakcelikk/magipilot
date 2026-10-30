// Chat models from the CLIs (docs/plans/phase-4-models.md M1, M2, M4, M5), vscode-free parts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  claudeModelsFromLine,
  codexModelsFromCatalog,
  DISCOVERY_TTL_MS,
  FAILURE_TTL_MS,
  SHRINK_CONFIRMATIONS,
  SHRINK_RETRY_MS,
  mergeModels,
  ModelDiscovery,
  sanitizeStored,
  type DiscoveredModel,
  type DiscoveryFailure,
} from '../../src/features/chat/modelDiscovery';
import { chatModels, effortFor, effortSchema, windowLabel } from '../../src/features/chat/models';

const fixture = (path: string): string =>
  readFileSync(join(__dirname, '..', 'fixtures', path), 'utf8');

/** The `initialize` answer as Claude Code 2.1.312 sends it, with an account block beside. */
function initializeLine(models: unknown): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'magipilot-models',
      response: {
        models,
        account: { email: 'not-a-real-account@example.invalid', organization: 'x' },
        commands: [{ name: 'x' }],
      },
    },
  });
}

describe('Claude: the initialize answer (M1, M2)', () => {
  const real = JSON.parse(fixture('claude/models.json')) as unknown[];

  it('lists every model except default, by value, with its display name', () => {
    const models = claudeModelsFromLine(initializeLine(real))!;
    expect(models.map((m) => m.id)).toEqual([
      'opus',
      'fable',
      'sonnet',
      'haiku',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
    ]);
    expect(models[2]).toMatchObject({ id: 'sonnet', displayName: 'Sonnet 5.5' });
  });

  it('keeps only the id and the display name: the account never leaves the parser', () => {
    const models = claudeModelsFromLine(
      initializeLine([
        { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'x', description: 'y' },
      ]),
    )!;
    for (const model of models) expect(Object.keys(model).sort()).toEqual(['displayName', 'id']);
    expect(JSON.stringify(models)).not.toContain('example.invalid');
  });

  it('is undefined for other lines and empty for an answer without usable models', () => {
    expect(claudeModelsFromLine('{"type":"system","subtype":"init"}')).toBeUndefined();
    expect(claudeModelsFromLine('not json')).toBeUndefined();
    expect(claudeModelsFromLine(initializeLine(undefined))).toEqual([]);
    expect(
      claudeModelsFromLine(
        initializeLine([
          { value: 'default', displayName: 'Default' },
          { value: '--model x', displayName: 'flag' },
          { value: 42 },
          { value: 'haiku', displayName: 'Haiku' },
          { value: 'haiku', displayName: 'again' },
          { value: 'sonnet', displayName: 'x'.repeat(200) },
        ]),
      ),
    ).toEqual([
      { id: 'haiku', displayName: 'Haiku' },
      { id: 'sonnet', displayName: 'sonnet' },
    ]);
  });
});

describe('Codex: the model catalog (M1, M2)', () => {
  it('lists the models with visibility "list", by priority, by slug', () => {
    const models = codexModelsFromCatalog(fixture('codex/models.json'))!;
    expect(models.map((m) => m.id)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6.1-terra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(models[4]).toMatchObject({ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' });
  });

  it('drops every other field, base instructions included', () => {
    const models = codexModelsFromCatalog(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6-luna',
            display_name: 'GPT-6-Luna',
            visibility: 'list',
            priority: 1,
            base_instructions: 'SECRET-PROMPT',
          },
        ],
      }),
    )!;
    expect(models).toEqual([{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }]);
    expect(JSON.stringify(models)).not.toContain('SECRET-PROMPT');
  });

  it('is undefined for text that is not the catalog', () => {
    expect(codexModelsFromCatalog('nope')).toBeUndefined();
    expect(codexModelsFromCatalog('{"data":[]}')).toBeUndefined();
    expect(codexModelsFromCatalog('{"models":[]}')).toEqual([]);
  });
});

describe('merge and names (M1, P4M-R001)', () => {
  it('adds the configured ids that discovery lacks', () => {
    expect(
      mergeModels([{ id: 'haiku', displayName: 'Haiku 5.5' }], ['haiku', ' claude-x ', '-bad']),
    ).toEqual([
      { id: 'haiku', displayName: 'Haiku 5.5' },
      { id: 'claude-x', displayName: 'claude-x' },
    ]);
  });

  it("names a model by the CLI's own name, keeps its id, and tells shared names apart", () => {
    const gates = {
      trusted: true,
      platform: 'darwin' as NodeJS.Platform,
      claudeAvailable: true,
      codexAvailable: true,
    };
    const on = chatModels(
      {
        claudeModels: mergeModels([{ id: 'sonnet', displayName: 'Sonnet 5.5' }], ['claude-x']),
        codexModels: [],
      },
      gates,
    );
    const off = chatModels({ claudeModels: ['sonnet'], codexModels: [] }, gates);
    // The user's choice (2026-10-29): `Opus 5.5`, not `Claude (CLI) · opus`.
    expect(on.map((m) => m.name)).toEqual(['Sonnet 5.5', 'claude-x']);
    expect(off[0]!.name).toBe('sonnet');
    // The id, and so a stored model id, stays the same in every mode.
    expect(on[0]!.id).toBe(off[0]!.id);
    expect(on[0]!.detail).toBe('194K');
    expect(on[0]!.tooltip).toContain('Sonnet 5.5');
    const twice = chatModels(
      {
        claudeModels: [
          { id: 'opus', displayName: 'Opus' },
          { id: 'claude-opus-x', displayName: 'Opus' },
        ],
        codexModels: [],
      },
      gates,
    );
    expect(twice.map((m) => m.name)).toEqual(['Opus (opus)', 'Opus (claude-opus-x)']);
    // The same configured id in both CLIs: the backend-qualified id tells them apart (P4E-I002).
    const both = chatModels({ claudeModels: ['shared'], codexModels: ['shared'] }, gates);
    expect(both.map((m) => m.name)).toEqual([
      'shared (claude-cli.shared)',
      'shared (codex-cli.shared)',
    ]);
    const sameDisplay = chatModels(
      {
        claudeModels: [{ id: 'x', displayName: 'X' }],
        codexModels: [{ id: 'x', displayName: 'X' }],
      },
      gates,
    );
    expect(new Set(sameDisplay.map((m) => m.name)).size).toBe(2);
    // A made name that equals another model's real name gets a number (P4E-I003).
    const clash = chatModels(
      {
        claudeModels: ['shared', { id: 'other', displayName: 'shared (claude-cli.shared)' }],
        codexModels: ['shared'],
      },
      gates,
    );
    const names = clash.map((m) => m.name);
    expect(new Set(names).size).toBe(3);
    expect(names).toContain('shared (claude-cli.shared) 2');
  });

  it('checks a stored list again (globalState is data from disk)', () => {
    expect(
      sanitizeStored(
        [{ id: 'haiku', displayName: 'Haiku', extra: 1 }, { id: '-x' }, 'x'],
        'claude',
      ),
    ).toEqual([{ id: 'haiku', displayName: 'Haiku' }]);
    expect(sanitizeStored('x', 'claude')).toBeUndefined();
    expect(sanitizeStored([], 'codex')).toBeUndefined();
  });
});

describe('ModelDiscovery: when to ask, and the fallback (M4, M5)', () => {
  const HAIKU: DiscoveredModel[] = [{ id: 'haiku', displayName: 'Haiku 5.5' }];
  const BOTH: DiscoveredModel[] = [...HAIKU, { id: 'sonnet', displayName: 'Sonnet 5.5' }];

  function setup(
    results: (DiscoveredModel[] | DiscoveryFailure)[],
    stored?: unknown,
    environment?: () => string,
  ) {
    let now = 1_000;
    const store = new Map<string, unknown>();
    if (stored !== undefined) store.set('claude:claude', stored);
    const probe = vi.fn(() => Promise.resolve(results.shift() ?? 'no-models'));
    const onChange = vi.fn();
    const log = vi.fn();
    const discovery = new ModelDiscovery({
      probe,
      store: { get: (key) => store.get(key), set: (key, models) => store.set(key, models) },
      onChange,
      log,
      now: () => now,
      ...(environment ? { environment } : {}),
    });
    return { discovery, probe, onChange, log, store, advance: (ms: number) => (now += ms) };
  }

  it('asks once, then answers from the cache until the TTL', async () => {
    const t = setup([HAIKU, BOTH]);
    expect(await t.discovery.models('claude', 'claude')).toEqual(HAIKU);
    expect(await t.discovery.models('claude', 'claude')).toEqual(HAIKU);
    expect(t.probe).toHaveBeenCalledTimes(1);
    t.advance(DISCOVERY_TTL_MS);
    // The first list counts as a change (there was none); the next one only if it differs.
    expect(t.onChange).toHaveBeenCalledTimes(1);
    // The last list answers at once while the CLI is asked again in the background.
    expect(await t.discovery.models('claude', 'claude')).toEqual(HAIKU);
    await vi.waitFor(() => expect(t.onChange).toHaveBeenCalledTimes(2));
    expect(await t.discovery.models('claude', 'claude')).toEqual(BOTH);
    expect(t.probe).toHaveBeenCalledTimes(2);
  });

  it('runs one probe at a time per CLI and path', async () => {
    const t = setup([HAIKU]);
    const [a, b] = await Promise.all([
      t.discovery.models('claude', 'claude'),
      t.discovery.models('claude', 'claude'),
    ]);
    expect(a).toEqual(HAIKU);
    expect(b).toEqual(HAIKU);
    expect(t.probe).toHaveBeenCalledTimes(1);
  });

  it('stores ids and display names, and starts from the stored list', async () => {
    const first = setup([HAIKU]);
    await first.discovery.models('claude', 'claude');
    expect(first.store.get('claude:claude')).toEqual(HAIKU);
    const next = setup(['timeout'], first.store.get('claude:claude'));
    // The stored list answers at once; the failed probe keeps it.
    expect(await next.discovery.models('claude', 'claude')).toEqual(HAIKU);
    await vi.waitFor(() =>
      expect(next.log).toHaveBeenCalledWith(expect.objectContaining({ failure: 'timeout' })),
    );
    expect(await next.discovery.models('claude', 'claude')).toEqual(HAIKU);
    expect(next.onChange).not.toHaveBeenCalled();
  });

  it('gives undefined after a failure without any earlier list, and waits before asking again', async () => {
    for (const failure of [
      'not-installed',
      'timeout',
      'exit',
      'no-models',
      'unreadable',
    ] as const) {
      const t = setup([failure, HAIKU]);
      expect(await t.discovery.models('claude', 'claude'), failure).toBeUndefined();
      expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ cli: 'claude', failure }));
      expect(await t.discovery.models('claude', 'claude')).toBeUndefined();
      expect(t.probe).toHaveBeenCalledTimes(1);
      t.advance(FAILURE_TTL_MS);
      expect(await t.discovery.models('claude', 'claude')).toEqual(HAIKU);
    }
  });

  it('asks again after invalidate(), and fires a change only for a different list', async () => {
    const t = setup([HAIKU, HAIKU, BOTH]);
    await t.discovery.models('claude', 'claude');
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.discovery.invalidate();
    await t.discovery.models('claude', 'claude');
    await vi.waitFor(() => expect(t.probe).toHaveBeenCalledTimes(2));
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.discovery.invalidate();
    await t.discovery.models('claude', 'claude');
    await vi.waitFor(() => expect(t.onChange).toHaveBeenCalledTimes(2));
  });

  it('keeps the last list against a shorter answer until it comes three times in a row', async () => {
    // Claude Code sometimes lists only its aliases (2026-10-30): a subset of the last list.
    const FULL: DiscoveredModel[] = [
      ...BOTH,
      { id: 'opus', displayName: 'Opus 5.5' },
      { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    ];
    const t = setup([BOTH, FULL, BOTH], FULL);
    expect(await t.discovery.models('claude', 'claude')).toEqual(FULL);
    await vi.waitFor(() => expect(t.probe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(t.log).toHaveBeenCalledWith(expect.objectContaining({ models: 2, kept: 4 })),
    );
    expect(t.store.get('claude:claude')).toEqual(FULL);
    expect(await t.discovery.models('claude', 'claude')).toEqual(FULL);
    expect(t.onChange).not.toHaveBeenCalled();
    // Asked again after SHRINK_RETRY_MS, not the full TTL; the full list then resets the count.
    t.advance(SHRINK_RETRY_MS);
    await t.discovery.models('claude', 'claude');
    await vi.waitFor(() => expect(t.probe).toHaveBeenCalledTimes(2));
    t.advance(DISCOVERY_TTL_MS);
    await t.discovery.models('claude', 'claude');
    await vi.waitFor(() => expect(t.probe).toHaveBeenCalledTimes(3));
    // One short answer after a full one is not taken either.
    expect(await t.discovery.models('claude', 'claude')).toEqual(FULL);
    expect(t.store.get('claude:claude')).toEqual(FULL);
  });

  it('takes a shorter answer on its third time in a row: a model really went', async () => {
    const t = setup([HAIKU, HAIKU, HAIKU], BOTH);
    await t.discovery.models('claude', 'claude');
    for (let probes = 2; probes <= SHRINK_CONFIRMATIONS; probes++) {
      t.advance(SHRINK_RETRY_MS);
      await vi.waitFor(async () => {
        await t.discovery.models('claude', 'claude');
        expect(t.probe).toHaveBeenCalledTimes(probes);
      });
    }
    await vi.waitFor(() => expect(t.onChange).toHaveBeenCalledTimes(1));
    expect(await t.discovery.models('claude', 'claude')).toEqual(HAIKU);
    expect(t.store.get('claude:claude')).toEqual(HAIKU);
  });

  it('takes a different list at once', async () => {
    const OTHER: DiscoveredModel[] = [{ id: 'fable', displayName: 'Fable 5.1' }];
    const t = setup([OTHER], BOTH);
    await t.discovery.models('claude', 'claude');
    await vi.waitFor(() => expect(t.onChange).toHaveBeenCalledTimes(1));
    expect(await t.discovery.models('claude', 'claude')).toEqual(OTHER);
    expect(t.store.get('claude:claude')).toEqual(OTHER);
  });

  it('keeps the guard over an unrelated settings change, and drops it when the environment changes (P4DF-004–006)', async () => {
    const FULL: DiscoveredModel[] = [...BOTH, { id: 'opus', displayName: 'Opus 5.5' }];
    let environment = '';
    const t = setup([FULL, BOTH, BOTH, HAIKU], FULL, () => environment);
    // Each probe logs once when it has answered.
    const probes = async (count: number) => {
      await t.discovery.models('claude', 'claude');
      await vi.waitFor(() => expect(t.log).toHaveBeenCalledTimes(count));
    };
    await probes(1);
    // Another setting changed (or trust was granted): the next shorter answer is still guarded.
    t.discovery.invalidate();
    await probes(2);
    await vi.waitFor(() =>
      expect(t.log).toHaveBeenLastCalledWith(expect.objectContaining({ models: 2, kept: 3 })),
    );
    expect(t.store.get('claude:claude')).toEqual(FULL);
    // The privacy setting turned on: Claude lists fewer models for real, taken at once.
    environment = 'private';
    t.discovery.invalidate();
    await probes(3);
    await vi.waitFor(() => expect(t.store.get('claude:claude')).toEqual(BOTH));
    expect(t.onChange).toHaveBeenCalledTimes(1);
    // Under the new environment, a shorter answer is guarded again.
    t.advance(DISCOVERY_TTL_MS);
    await probes(4);
    await vi.waitFor(() =>
      expect(t.log).toHaveBeenLastCalledWith(expect.objectContaining({ models: 1, kept: 2 })),
    );
    expect(t.store.get('claude:claude')).toEqual(BOTH);
    // One stored list per CLI and path, as before.
    expect([...t.store.keys()]).toEqual(['claude:claude']);
  });

  it('counts only shorter answers in a row: a failure starts the count again (P4DF-003)', async () => {
    const t = setup([HAIKU, HAIKU, 'no-models', HAIKU], BOTH);
    const ask = async (probes: number) => {
      await vi.waitFor(async () => {
        await t.discovery.models('claude', 'claude');
        expect(t.probe).toHaveBeenCalledTimes(probes);
      });
    };
    await ask(1);
    t.advance(SHRINK_RETRY_MS);
    await ask(2);
    t.advance(SHRINK_RETRY_MS);
    await ask(3);
    t.advance(FAILURE_TTL_MS);
    await ask(4);
    // The fourth answer is the first shorter one since the failure: still not taken.
    await vi.waitFor(() =>
      expect(t.log).toHaveBeenLastCalledWith(expect.objectContaining({ models: 1, kept: 2 })),
    );
    expect(await t.discovery.models('claude', 'claude')).toEqual(BOTH);
    expect(t.store.get('claude:claude')).toEqual(BOTH);
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it('takes a shorter Codex catalog at once, with the usual TTL (P4DF-002)', async () => {
    const SOL: DiscoveredModel[] = [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol' }];
    const BOTH_CODEX: DiscoveredModel[] = [...SOL, { id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }];
    let now = 1_000;
    const store = new Map<string, unknown>([['codex:codex', BOTH_CODEX]]);
    const results: DiscoveredModel[][] = [SOL];
    const probe = vi.fn(() => Promise.resolve(results.shift() ?? SOL));
    const onChange = vi.fn();
    const discovery = new ModelDiscovery({
      probe,
      store: { get: (key) => store.get(key), set: (key, models) => store.set(key, models) },
      onChange,
      log: vi.fn(),
      now: () => now,
    });
    await discovery.models('codex', 'codex');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(await discovery.models('codex', 'codex')).toEqual(SOL);
    expect(store.get('codex:codex')).toEqual(SOL);
    // Not asked again before the usual TTL.
    now += SHRINK_RETRY_MS;
    await discovery.models('codex', 'codex');
    expect(probe).toHaveBeenCalledTimes(1);
    now += DISCOVERY_TTL_MS;
    await discovery.models('codex', 'codex');
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2));
  });

  it('a refresh queued behind an older probe runs alone, under the new environment', async () => {
    const log = vi.fn();
    let release: (models: DiscoveredModel[]) => void = () => undefined;
    let calls = 0;
    let running = 0;
    let most = 0;
    let now = 1_000;
    let environment = '';
    const store = new Map<string, unknown>([['claude:claude', BOTH]]);
    const discovery = new ModelDiscovery({
      // The first probe answers at once, the second waits for `release`, the third answers short.
      probe: () => {
        running++;
        most = Math.max(most, running);
        const call = calls++;
        const answer =
          call === 0
            ? Promise.resolve(BOTH)
            : call === 1
              ? new Promise<DiscoveredModel[]>((resolve) => {
                  release = resolve;
                })
              : Promise.resolve(HAIKU);
        return answer.finally(() => running--);
      },
      store: { get: (key) => store.get(key), set: (key, models) => store.set(key, models) },
      onChange: vi.fn(),
      log,
      now: () => now,
      environment: () => environment,
    });
    await discovery.models('claude', 'claude');
    // The first probe has answered (it logs when done).
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    now += DISCOVERY_TTL_MS;
    expect(await discovery.models('claude', 'claude')).toEqual(BOTH);
    // The privacy setting changes while the second probe runs.
    environment = 'private';
    discovery.invalidate();
    expect(await discovery.models('claude', 'claude')).toEqual(BOTH);
    release(BOTH);
    // The older result is dropped; the queued refresh runs under the new environment, so its
    // shorter answer is taken; and never two probes at once (P4M-RI001).
    await vi.waitFor(() => expect(store.get('claude:claude')).toEqual(HAIKU));
    expect(calls).toBe(3);
    expect(most).toBe(1);
  });

  it('logs meta only: the CLI, a count or a failure kind, and a duration', async () => {
    const t = setup([HAIKU]);
    await t.discovery.models('claude', 'claude');
    const [event] = t.log.mock.calls[0] as [Record<string, unknown>];
    expect(Object.keys(event).sort()).toEqual(['cli', 'models', 'ms']);
  });

  it('drops the result of a probe that was running when the settings changed (P4M-I001)', async () => {
    const OLD: DiscoveredModel[] = [{ id: 'opus', displayName: 'Opus' }];
    let release: (models: DiscoveredModel[]) => void = () => undefined;
    let calls = 0;
    const store = new Map<string, unknown>();
    const discovery = new ModelDiscovery({
      // The first probe waits for `release`; the next answers at once.
      probe: () =>
        calls++ === 0
          ? new Promise<DiscoveredModel[]>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(BOTH),
      store: { get: (key) => store.get(key), set: (key, models) => store.set(key, models) },
      onChange: () => undefined,
      log: () => undefined,
    });
    const first = discovery.models('claude', 'claude');
    // The settings change while the first probe runs.
    discovery.invalidate();
    // The new probe waits for the old one (one process at a time, P4M-RI001).
    const second = discovery.models('claude', 'claude');
    // The old probe ends under the old settings: its list must land nowhere.
    release(OLD);
    expect(await second).toEqual(BOTH);
    expect(await first).not.toEqual(OLD);
    // The new generation probed on its own and got the new list; the old one was dropped.
    expect(await second).toEqual(BOTH);
    expect(store.get('claude:claude')).toEqual(BOTH);
    expect(await discovery.models('claude', 'claude')).toEqual(BOTH);
  });

  it('never runs two probes at once for one CLI and path, also across a settings change (P4M-RI001)', async () => {
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const discovery = new ModelDiscovery({
      probe: () => {
        running++;
        most = Math.max(most, running);
        return new Promise<DiscoveredModel[]>((resolve) => {
          releases.push(() => {
            running--;
            resolve(BOTH);
          });
        });
      },
      onChange: () => undefined,
      log: () => undefined,
    });
    const first = discovery.models('claude', 'claude');
    discovery.invalidate();
    const second = discovery.models('claude', 'claude');
    discovery.invalidate();
    const third = discovery.models('claude', 'claude');
    await vi.waitFor(() => expect(releases.length).toBe(1));
    releases.shift()!();
    await vi.waitFor(() => expect(releases.length).toBe(1));
    releases.shift()!();
    await Promise.all([first, second, third]);
    expect(most).toBe(1);
    expect(await discovery.models('claude', 'claude')).toEqual(BOTH);
  });
});

describe('effort levels and context windows (phase-4-effort.md E1-E4, E7)', () => {
  const claude = () =>
    claudeModelsFromLine(initializeLine(JSON.parse(fixture('claude/models.json')) as unknown[]))!;
  const codex = () => codexModelsFromCatalog(fixture('codex/models.json'))!;

  it("reads Claude's levels per model, without a default", () => {
    const byId = new Map(claude().map((m) => [m.id, m]));
    expect(byId.get('opus')!.efforts!.map((l) => l.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(byId.get('claude-opus-4-6')!.efforts!.map((l) => l.id)).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(byId.get('claude-haiku-4-5-20251001')!.efforts).toBeUndefined();
    expect(byId.get('opus')!.defaultEffort).toBeUndefined();
    expect(byId.get('opus')!.contextWindow).toBeUndefined();
  });

  it("reads Codex's levels with descriptions, its default level and its window", () => {
    const byId = new Map(codex().map((m) => [m.id, m]));
    const sol = byId.get('gpt-6.1-sol')!;
    expect(sol.efforts!.map((l) => l.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(sol.efforts![5]!.description).toBe('Maximum reasoning with automatic task delegation');
    expect(sol.defaultEffort).toBe('low');
    expect(sol.contextWindow).toBe(500_000);
    const luna = byId.get('gpt-6-luna')!;
    expect(luna.efforts!.map((l) => l.id)).not.toContain('ultra');
    expect(luna.defaultEffort).toBe('medium');
    expect(luna.contextWindow).toBe(272_000);
  });

  it('drops unknown levels, cuts long descriptions, and bounds the window', () => {
    const [model] = codexModelsFromCatalog(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-x',
            display_name: 'X',
            visibility: 'list',
            priority: 1,
            supported_reasoning_levels: [
              { effort: 'low', description: 'd'.repeat(500) },
              { effort: '--rm -rf', description: 'x' },
              { effort: 'low', description: 'twice' },
            ],
            default_reasoning_level: 'turbo',
            context_window: 99_000_000,
          },
        ],
      }),
    )!;
    expect(model!.efforts).toEqual([{ id: 'low', description: 'd'.repeat(200) }]);
    expect(model!.defaultEffort).toBeUndefined();
    expect(model!.contextWindow).toBeUndefined();
    // Claude's set has no `ultra`.
    const [opus] = claudeModelsFromLine(
      initializeLine([
        { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['ultra', 'max'] },
      ]),
    )!;
    expect(opus!.efforts).toEqual([{ id: 'max' }]);
  });

  it('keeps the levels and the window through the store, and reads the old stored shape', () => {
    const models = codex();
    const stored = JSON.parse(JSON.stringify(models)) as unknown;
    expect(sanitizeStored(stored, 'codex')).toEqual(models);
    expect(sanitizeStored([{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna' }], 'codex')).toEqual([
      { id: 'gpt-6-luna', displayName: 'GPT-6-Luna' },
    ]);
  });

  it('offers a stored list with its levels after a restart and a failed probe (E4)', async () => {
    const store = new Map<string, unknown>();
    const first = new ModelDiscovery({
      probe: () => Promise.resolve(codex()),
      store: { get: (key) => store.get(key), set: (key, models) => store.set(key, models) },
      onChange: () => undefined,
      log: () => undefined,
    });
    await first.models('codex', 'codex');
    const restarted = new ModelDiscovery({
      probe: () => Promise.resolve('timeout' as const),
      store: {
        get: (key) => JSON.parse(JSON.stringify(store.get(key))) as unknown,
        set: () => undefined,
      },
      onChange: () => undefined,
      log: () => undefined,
    });
    const models = (await restarted.models('codex', 'codex'))!;
    expect(models.find((m) => m.id === 'gpt-6.1-sol')).toMatchObject({
      defaultEffort: 'low',
      contextWindow: 500_000,
    });
  });

  it('fires a change for a metadata-only difference, not for an identical list (E7)', async () => {
    const base = codex();
    const changed = base.map((m) => (m.id === 'gpt-6-luna' ? { ...m, defaultEffort: 'high' } : m));
    const results = [base, base, changed];
    const onChange = vi.fn();
    const discovery = new ModelDiscovery({
      probe: () => Promise.resolve(results.shift()!),
      onChange,
      log: () => undefined,
    });
    await discovery.models('codex', 'codex');
    expect(onChange).toHaveBeenCalledTimes(1);
    discovery.invalidate();
    await discovery.models('codex', 'codex');
    await vi.waitFor(() => expect(results.length).toBe(1));
    expect(onChange).toHaveBeenCalledTimes(1);
    discovery.invalidate();
    await discovery.models('codex', 'codex');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
  });

  it("builds the picker's effort choice: Claude with Auto first, Codex with its default (E1)", () => {
    const opus = claude().find((m) => m.id === 'opus')!;
    const claudeSchema = effortSchema('claude-cli', opus)!.properties.reasoningEffort!;
    expect(claudeSchema.enum).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(claudeSchema.enumItemLabels[0]).toBe('Auto');
    expect(claudeSchema.default).toBe('auto');
    expect(claudeSchema.title).toBe('Effort Level');
    expect(claudeSchema.group).toBe('navigation');
    const sol = codex().find((m) => m.id === 'gpt-6.1-sol')!;
    const codexSchema = effortSchema('codex-cli', sol)!.properties.reasoningEffort!;
    expect(codexSchema.enum).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(codexSchema.enumItemLabels.at(-1)).toBe('Ultra');
    expect(codexSchema.enumDescriptions[0]).toBe('Fast responses with lighter reasoning');
    expect(codexSchema.default).toBe('low');
    // No levels, no choice: a configured id, or Haiku 4.5.
    expect(effortSchema('claude-cli', { id: 'x' })).toBeUndefined();
  });

  it('takes the effort of a request from the choice, else the default; auto means none (E2)', () => {
    const opus = effortSchema(
      'claude-cli',
      claude().find((m) => m.id === 'opus')!,
    );
    expect(effortFor(opus, 'max')).toBe('max');
    expect(effortFor(opus, 'auto')).toBeUndefined();
    expect(effortFor(opus, undefined)).toBeUndefined();
    // A value outside the model's levels is ignored.
    expect(effortFor(opus, 'ultra')).toBeUndefined();
    expect(effortFor(opus, 42)).toBeUndefined();
    const luna = effortSchema(
      'codex-cli',
      codex().find((m) => m.id === 'gpt-6-luna')!,
    );
    expect(effortFor(luna, 'xhigh')).toBe('xhigh');
    expect(effortFor(luna, 'ultra')).toBe('medium');
    expect(effortFor(luna, undefined)).toBe('medium');
    expect(effortFor(undefined, 'high')).toBeUndefined();
  });

  it('shows the size Copilot can use from the window: the catalog for Codex, the assumed one for Claude (E3, phase-4-picker.md U6)', () => {
    const gates = {
      trusted: true,
      platform: 'darwin' as NodeJS.Platform,
      claudeAvailable: true,
      codexAvailable: true,
    };
    const models = chatModels({ claudeModels: claude(), codexModels: codex() }, gates);
    const byId = new Map(models.map((m) => [m.id, m]));
    // 95 % of 500 000, less 12 000 + 4 000, plus 16 000 for the answer.
    expect(byId.get('codex-cli.gpt-6.1-sol')).toMatchObject({
      name: 'GPT-6.1-Sol',
      detail: '459K',
      maxContextWindowTokens: 459_000,
    });
    expect(byId.get('claude-cli.opus')).toMatchObject({
      name: 'Opus 5.5',
      detail: '194K',
      maxContextWindowTokens: 194_000,
    });
    expect(
      byId.get('claude-cli.opus')!.configurationSchema!.properties.reasoningEffort,
    ).toBeDefined();
    // Every model has its context size; Haiku 4.5 has no effort levels.
    const haiku = byId.get('claude-cli.claude-haiku-4-5-20251001')!.configurationSchema!;
    expect(haiku.properties.reasoningEffort).toBeUndefined();
    // Its tier and its full size (phase-4-sizes.md S1).
    expect(haiku.properties.contextTier!.enum).toEqual([128_000, 194_000]);
    expect(windowLabel(272_000)).toBe('272K');
    expect(windowLabel(1_000_000)).toBe('1M');
  });
});
