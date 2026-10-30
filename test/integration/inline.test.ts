// P6 (docs/plans/phase-1.md): the inline provider inside VS Code with an injected FakeBackend.
// Excluded files never cause a backend call, and never appear as snippets (AGENTS rule 6).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CliFailure, failureMessage } from '../../src/core/backends/failures';
import type { Backend, CompletionRequest } from '../../src/core/backends/types';
import type { TestApi } from '../../src/extension';

const RAW = '```ts\n  return a + b;\n```';
const SECRET = 'not-a-real-secret';

class FakeBackend implements Backend {
  readonly id = 'claude-cli' as const;
  readonly kind = 'chat' as const;
  readonly requests: CompletionRequest[] = [];

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  complete(req: CompletionRequest): Promise<string> {
    this.requests.push(req);
    return Promise.resolve(RAW);
  }

  run(): AsyncIterable<string> {
    return (async function* () {})();
  }

  dispose(): void {}
}

/**
 * A backend whose requests take `answerMs` and, like a CLI that ignores SIGTERM for a while,
 * keep running for `dieMs` after an abort. Tracks how many requests run at the same time.
 */
class SlowBackend extends FakeBackend {
  active = 0;
  maxActive = 0;

  constructor(
    private readonly answerMs: number,
    private readonly dieMs: number,
  ) {
    super();
  }

  override complete(req: CompletionRequest): Promise<string> {
    this.requests.push(req);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise<string>((resolve, reject) => {
      const done = setTimeout(() => {
        this.active--;
        resolve(RAW);
      }, this.answerMs);
      req.signal.addEventListener('abort', () => {
        clearTimeout(done);
        setTimeout(() => {
          this.active--;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, this.dieMs);
      });
    });
  }
}

/** A CLI backend that fails with a classified kind (phase-3-errors). */
class FailingBackend extends FakeBackend {
  constructor(private readonly failure: 'not-logged-in' | 'limit') {
    super();
  }
  override complete(req: CompletionRequest): Promise<string> {
    this.requests.push(req);
    return Promise.reject(new CliFailure('claude', this.failure, 'exit 1'));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function root(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test workspace must be open');
  return folder.uri;
}

async function open(path: string, languageId?: string): Promise<vscode.TextEditor> {
  let document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root(), path));
  if (languageId && document.languageId !== languageId) {
    document = await vscode.languages.setTextDocumentLanguage(document, languageId);
  }
  return vscode.window.showTextDocument(document, { preview: false });
}

async function invoke(
  api: TestApi,
  editor: vscode.TextEditor,
  position: vscode.Position,
  triggerKind = vscode.InlineCompletionTriggerKind.Invoke,
): Promise<vscode.InlineCompletionItem[]> {
  const source = new vscode.CancellationTokenSource();
  const context = {
    triggerKind,
    selectedCompletionInfo: undefined,
  } as vscode.InlineCompletionContext;
  return api.provider.provideInlineCompletionItems(
    editor.document,
    position,
    context,
    source.token,
  );
}

function end(editor: vscode.TextEditor): vscode.Position {
  return editor.document.lineAt(editor.document.lineCount - 1).range.end;
}

describe('Magipilot inline provider (FakeBackend)', () => {
  let api: TestApi;
  let fake: FakeBackend;

  before(async () => {
    const extension = vscode.extensions.getExtension<TestApi | undefined>(
      'celalakcelikk.magipilot',
    );
    assert.ok(extension);
    const exported = await extension.activate();
    assert.ok(exported, 'activate() returns the test API when MAGIPILOT_TEST=1');
    api = exported;
  });

  beforeEach(() => {
    fake = new FakeBackend();
    api.setBackendOverride(fake);
  });

  after(async () => {
    api.setBackendOverride(undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  for (const path of ['.env', '.env.local', 'secrets/key.txt', 'cert.pem']) {
    it(`never calls the backend for ${path} (even as TypeScript)`, async () => {
      const editor = await open(path, 'typescript');
      const items = await invoke(api, editor, end(editor));
      assert.deepEqual(items, []);
      assert.equal(fake.requests.length, 0);
    });
  }

  for (const kind of ['not-logged-in', 'limit'] as const) {
    it(`a ${kind} CLI shows its message, then gets no automatic request until the manual trigger (phase-3-errors AC3, AC4)`, async () => {
      const failing = new FailingBackend(kind);
      api.setBackendOverride(failing);
      const editor = await open('src/a.ts');
      const position = new vscode.Position(3, 9);
      const automatic = vscode.InlineCompletionTriggerKind.Automatic;
      assert.deepEqual(await invoke(api, editor, position, automatic), []);
      assert.equal(failing.requests.length, 1);
      const state = api.statusState();
      assert.equal(state.kind, 'error');
      assert.equal('message' in state ? state.message : undefined, failureMessage('claude', kind));
      // The cool-down: typing does not start the failing CLI again.
      assert.deepEqual(await invoke(api, editor, position, automatic), []);
      assert.equal(failing.requests.length, 1);
      // Alt+\ tries again at once.
      await invoke(api, editor, position);
      assert.equal(failing.requests.length, 2);
    });
  }

  it('positive control: src/a.ts gets the post-processed fake completion', async () => {
    const editor = await open('src/a.ts');
    const items = await invoke(api, editor, new vscode.Position(3, 9));
    assert.equal(fake.requests.length, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.insertText, 'a + b;');
    const request = fake.requests[0]!;
    assert.equal(request.filePath, 'src/a.ts');
    assert.ok(request.prefix.endsWith('  return '));
    assert.ok(!request.prefix.includes(SECRET) && !request.suffix.includes(SECRET));
  });

  it('open excluded documents never become snippets; an allowed one does', async () => {
    // All of them TypeScript, so only the exclude rule can keep them out.
    await open('.env', 'typescript');
    await open('secrets/keys.ts');
    await open('src/b.ts');
    const editor = await open('src/a.ts');
    await invoke(api, editor, new vscode.Position(3, 9));
    assert.equal(fake.requests.length, 1);
    const snippets = fake.requests[0]!.snippets;
    assert.deepEqual(
      snippets.map((s) => s.path),
      ['src/b.ts'],
    );
    assert.ok(snippets.every((s) => !s.text.includes(SECRET)));
  });

  it('never calls the backend for a disabled language (plaintext)', async () => {
    const editor = await open('notes.txt');
    assert.equal(editor.document.languageId, 'plaintext');
    assert.deepEqual(await invoke(api, editor, end(editor)), []);
    assert.equal(fake.requests.length, 0);
  });

  it('never calls the backend while text is selected', async () => {
    const editor = await open('src/a.ts');
    editor.selection = new vscode.Selection(0, 0, 0, 6);
    assert.deepEqual(await invoke(api, editor, new vscode.Position(3, 9)), []);
    assert.equal(fake.requests.length, 0);
    editor.selection = new vscode.Selection(3, 9, 3, 9);
  });

  it('manual mode ignores automatic triggers but serves Alt+\\ (Invoke)', async () => {
    const config = vscode.workspace.getConfiguration('magipilot');
    await config.update('inline.mode', 'manual', vscode.ConfigurationTarget.Global);
    try {
      api.setBackendOverride(fake); // the settings change cleared the cache
      const editor = await open('src/a.ts');
      const position = new vscode.Position(3, 9);
      assert.deepEqual(
        await invoke(api, editor, position, vscode.InlineCompletionTriggerKind.Automatic),
        [],
      );
      assert.equal(fake.requests.length, 0);
      assert.equal((await invoke(api, editor, position)).length, 1);
      assert.equal(fake.requests.length, 1);
    } finally {
      await config.update('inline.mode', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  for (const [label, key, value] of [
    ['the file becomes excluded', 'exclude', ['src/a.ts']],
    ['inline completion is turned off', 'inline.enabled', false],
  ] as const) {
    it(`sends nothing when ${label} during the debounce (P1-I002)`, async () => {
      const config = vscode.workspace.getConfiguration('magipilot');
      await config.update('inline.debounceMs', 1500, vscode.ConfigurationTarget.Global);
      try {
        api.setBackendOverride(fake);
        const editor = await open('src/a.ts');
        const pending = invoke(
          api,
          editor,
          new vscode.Position(3, 9),
          vscode.InlineCompletionTriggerKind.Automatic,
        );
        await config.update(key, value, vscode.ConfigurationTarget.Global);
        assert.deepEqual(await pending, []);
        assert.equal(fake.requests.length, 0);
      } finally {
        await config.update(key, undefined, vscode.ConfigurationTarget.Global);
        await config.update('inline.debounceMs', undefined, vscode.ConfigurationTarget.Global);
      }
    });
  }

  it('serves a repeat at the same position from the cache', async () => {
    const editor = await open('src/a.ts');
    const position = new vscode.Position(3, 9);
    await invoke(api, editor, position);
    const second = await invoke(api, editor, position);
    assert.equal(fake.requests.length, 1);
    assert.equal(second[0]!.insertText, 'a + b;');
    // Accepting a cached item is credited to the backend that produced it (P1-I012).
    assert.deepEqual(second[0]!.command?.arguments, ['claude-cli']);
  });

  it('Show Stats renders a completed request; a cached repeat counts as shown; Reset Stats clears it (phase-3-metrics AC1-AC3)', async () => {
    await vscode.commands.executeCommand('magipilot.resetStats');
    const editor = await open('src/a.ts');
    const position = new vscode.Position(3, 9);
    const first = await invoke(api, editor, position);
    const second = await invoke(api, editor, position);
    assert.equal(fake.requests.length, 1);
    for (const item of [...first, ...second]) {
      const args = item.command!.arguments as unknown[];
      await vscode.commands.executeCommand(item.command!.command, ...args);
    }
    const stats = api.metrics.snapshot()['claude-cli'];
    assert.ok(stats);
    assert.equal(stats.requests, 1);
    assert.equal(stats.completions, 1);
    assert.equal(stats.shown, 2);
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.accepted, 2);
    assert.equal(stats.acceptanceRate, 1);

    await vscode.commands.executeCommand('magipilot.showStats');
    const html = api.statsHtml();
    assert.ok(html, 'the panel is open');
    assert.ok(html.includes('<th scope="row">claude-cli</th><td>1</td><td>1</td><td>0</td>'), html);
    assert.ok(
      html.includes('<th scope="row">claude-cli</th><td>2</td><td>1</td><td>2</td><td>100 %</td>'),
      html,
    );
    assert.ok(!html.includes('return a + b'), 'the panel shows no completion text');

    await vscode.commands.executeCommand('magipilot.resetStats');
    assert.deepEqual(api.metrics.snapshot(), {});
    assert.ok(api.statsHtml()!.includes('No inline completions yet.'));
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    assert.equal(api.statsHtml(), undefined);
  });

  it('a result cancelled just before delivery is a completion, not a shown suggestion (METRICS-002)', async () => {
    await vscode.commands.executeCommand('magipilot.resetStats');
    const source = new vscode.CancellationTokenSource();
    const cancelling = new (class extends FakeBackend {
      override complete(req: CompletionRequest): Promise<string> {
        this.requests.push(req);
        source.cancel();
        return Promise.resolve(RAW);
      }
    })();
    api.setBackendOverride(cancelling);
    const editor = await open('src/a.ts');
    const items = await api.provider.provideInlineCompletionItems(
      editor.document,
      new vscode.Position(3, 9),
      {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
      },
      source.token,
    );
    assert.deepEqual(items, []);
    const stats = api.metrics.snapshot()['claude-cli'];
    assert.ok(stats);
    assert.equal(stats.requests, 1);
    assert.equal(stats.completions, 1);
    assert.equal(stats.shown, 0);
  });

  it('an answer that arrives after its request was superseded is neither cached nor shown (METRICS-I001)', async () => {
    await vscode.commands.executeCommand('magipilot.resetStats');
    // Answers after 400 ms even when aborted, like a backend that ignores the abort signal.
    const ignoring = new (class extends FakeBackend {
      override complete(req: CompletionRequest): Promise<string> {
        this.requests.push(req);
        return new Promise((resolve) => setTimeout(() => resolve(RAW), 400));
      }
    })();
    api.setBackendOverride(ignoring);
    const editor = await open('src/a.ts');
    const first = invoke(api, editor, new vscode.Position(3, 9));
    await sleep(100);
    // A newer request supersedes the first; the first call's own token stays uncancelled.
    const second = invoke(api, editor, new vscode.Position(4, 1));
    assert.deepEqual(await first, []);
    assert.equal((await second).length, 1);
    const stats = api.metrics.snapshot()['claude-cli'];
    assert.ok(stats);
    assert.equal(stats.requests, 2);
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.completions, 1);
    assert.equal(stats.shown, 1);
    // The superseded answer was not cached: the first position asks the backend again.
    await invoke(api, editor, new vscode.Position(3, 9));
    assert.equal(ignoring.requests.length, 3);
  });

  it('a cache hit supersedes a pending request whose token stays uncancelled (METRICS-I003)', async () => {
    await vscode.commands.executeCommand('magipilot.resetStats');
    // The first call answers at once; later calls answer after 400 ms even when aborted.
    const twoSpeed = new (class extends FakeBackend {
      override complete(req: CompletionRequest): Promise<string> {
        this.requests.push(req);
        if (this.requests.length === 1) return Promise.resolve(RAW);
        return new Promise((resolve) => setTimeout(() => resolve(RAW), 400));
      }
    })();
    api.setBackendOverride(twoSpeed);
    const editor = await open('src/a.ts');
    const cachedAt = new vscode.Position(3, 9);
    assert.equal((await invoke(api, editor, cachedAt)).length, 1);
    const pending = invoke(api, editor, new vscode.Position(4, 1));
    await sleep(100);
    assert.equal((await invoke(api, editor, cachedAt)).length, 1); // from the cache
    assert.deepEqual(await pending, []);
    const stats = api.metrics.snapshot()['claude-cli'];
    assert.ok(stats);
    assert.equal(stats.requests, 2);
    assert.equal(stats.completions, 1);
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.shown, 2);
    assert.equal(stats.cacheHits, 1);
    assert.equal(api.statusState().kind, 'enabled');
    // The superseded answer was not cached: its position asks the backend again.
    await invoke(api, editor, new vscode.Position(4, 1));
    assert.equal(twoSpeed.requests.length, 3);
  });

  it('a superseded request counts as cancelled, not as an error (phase-3-metrics AC3)', async () => {
    await vscode.commands.executeCommand('magipilot.resetStats');
    const slow = new SlowBackend(5000, 0);
    api.setBackendOverride(slow);
    const editor = await open('src/a.ts');
    const first = invoke(api, editor, new vscode.Position(3, 9));
    await sleep(100);
    const second = invoke(api, editor, new vscode.Position(4, 1));
    assert.deepEqual(await first, []);
    api.setBackendOverride(new FakeBackend());
    assert.deepEqual(await second, []);
    const stats = api.metrics.snapshot()['claude-cli'];
    assert.ok(stats);
    assert.equal(stats.errors, 0);
    assert.equal(stats.shown, 0);
    assert.ok(stats.cancelled >= 1, JSON.stringify(stats));
    assert.equal(stats.requests, stats.cancelled);
  });

  it('a newer request waits until the aborted one has really finished (P1-I016)', async () => {
    const slow = new SlowBackend(5000, 600);
    api.setBackendOverride(slow);
    const editor = await open('src/a.ts');
    const first = invoke(api, editor, new vscode.Position(3, 9));
    await sleep(100);
    const second = invoke(api, editor, new vscode.Position(4, 1));
    await sleep(100);
    // The first request is aborted but still dying; the second must not have started yet.
    assert.equal(slow.requests.length, 1);
    assert.deepEqual(await first, []);
    await sleep(800);
    assert.equal(slow.requests.length, 2);
    assert.equal(slow.maxActive, 1);
    // Clean up: swapping the backend invalidates (aborts) the second request.
    api.setBackendOverride(new FakeBackend());
    assert.deepEqual(await second, []);
  });

  it('an aborted request does not overwrite the "disabled" status (P1-I017)', async () => {
    const slow = new SlowBackend(5000, 300);
    api.setBackendOverride(slow);
    const config = vscode.workspace.getConfiguration('magipilot');
    const editor = await open('src/a.ts');
    const pending = invoke(api, editor, new vscode.Position(3, 9));
    await sleep(100);
    assert.equal(api.statusState().kind, 'busy');
    await config.update('inline.enabled', false, vscode.ConfigurationTarget.Global);
    try {
      assert.deepEqual(await pending, []);
      await sleep(100);
      assert.equal(api.statusState().kind, 'disabled');
    } finally {
      await config.update('inline.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('the status bar toggle works against a workspace value of inline.enabled (P1-I011)', async () => {
    const config = (): vscode.WorkspaceConfiguration =>
      vscode.workspace.getConfiguration('magipilot');
    const workspace = vscode.ConfigurationTarget.Workspace;
    try {
      for (const start of [true, false]) {
        await config().update('inline.enabled', start, workspace);
        await vscode.commands.executeCommand('magipilot.toggleInline');
        assert.equal(config().get('inline.enabled'), !start);
        await vscode.commands.executeCommand('magipilot.toggleInline');
        assert.equal(config().get('inline.enabled'), start);
      }
    } finally {
      await config().update('inline.enabled', undefined, workspace);
      await config().update('inline.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
  });
  describe('import signatures (phase-3-context P5)', () => {
    const SIGNATURE = 'export function add(a: number, b: number): number;';
    const FORBIDDEN = [
      'D-BODY',
      'not-a-real-secret',
      'mulKey',
      'envSecret',
      'leakSecret',
      'outsideLeak',
    ];
    const C_POSITION = new vscode.Position(7, 21);
    const config = (): vscode.WorkspaceConfiguration =>
      vscode.workspace.getConfiguration('magipilot');

    beforeEach(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      api.setImportTiming({ delayMs: 0 });
    });

    afterEach(async () => {
      api.setImportTiming({ delayMs: 0 });
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    const texts = (request: CompletionRequest): string =>
      request.snippets.map((snippet) => `${snippet.path}\n${snippet.text}`).join('\n');

    it("(a, c, d, e) a TS file gets d's signature only: nothing excluded, nothing from outside the folder", async () => {
      const editor = await open('src/c.ts');
      assert.equal((await invoke(api, editor, C_POSITION)).length, 1);
      const request = fake.requests[0]!;
      assert.deepEqual(request.snippets, [{ path: 'src/d.ts', text: SIGNATURE }]);
      for (const word of FORBIDDEN) assert.ok(!texts(request).includes(word), word);
    });

    it('(b) a Python file gets the signature of its relative import', async () => {
      const editor = await open('py/main.py', 'python');
      await invoke(api, editor, new vscode.Position(2, 9));
      assert.deepEqual(fake.requests[0]!.snippets, [
        { path: 'py/util.py', text: 'def add(a: int, b: int) -> int: ...' },
      ]);
    });

    it('(f) inline.importSignatures off adds nothing', async () => {
      await config().update('inline.importSignatures', false, vscode.ConfigurationTarget.Global);
      try {
        const editor = await open('src/c.ts');
        await invoke(api, editor, C_POSITION);
        assert.deepEqual(fake.requests[0]!.snippets, []);
      } finally {
        await config().update(
          'inline.importSignatures',
          undefined,
          vscode.ConfigurationTarget.Global,
        );
      }
    });

    it('(g) an exclusion change while the gathering is pending sends nothing', async () => {
      api.setImportTiming({ delayMs: 200, deadlineMs: 10_000 });
      const editor = await open('src/c.ts');
      const pending = invoke(api, editor, C_POSITION);
      await sleep(100);
      const global = vscode.ConfigurationTarget.Global;
      await config().update('exclude', ['.env*', '*.pem', 'secrets/**', 'src/d.ts'], global);
      try {
        assert.deepEqual(await pending, []);
        assert.equal(fake.requests.length, 0);
      } finally {
        await config().update('exclude', undefined, global);
      }
    });

    it('(h) a newer request while the gathering is pending: only the newer one is sent', async () => {
      api.setImportTiming({ delayMs: 200, deadlineMs: 10_000 });
      const editor = await open('src/c.ts');
      const first = invoke(api, editor, C_POSITION);
      await sleep(100);
      api.setImportTiming({ delayMs: 0 });
      const second = invoke(api, editor, new vscode.Position(7, 0));
      assert.deepEqual(await first, []);
      await second;
      assert.equal(fake.requests.length, 1);
      assert.ok(fake.requests[0]!.prefix.endsWith('\n'), 'the request is the newer one');
    });

    it('(i) editing an imported declaration, unsaved or on disk, makes the same position ask again', async () => {
      const editor = await open('src/c.ts');
      await invoke(api, editor, C_POSITION);
      await invoke(api, editor, C_POSITION);
      assert.equal(fake.requests.length, 1, 'the repeat is served from the cache');

      // Unsaved edit in an open editor.
      const d = await open('src/d.ts');
      await d.edit((edit) => edit.insert(new vscode.Position(0, 20), 'first'));
      await vscode.window.showTextDocument(editor.document);
      await invoke(api, editor, C_POSITION);
      assert.equal(fake.requests.length, 2);
      assert.ok(texts(fake.requests[1]!).includes('add(firsta: number'));
      await vscode.window.showTextDocument(d.document);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');

      // On disk.
      await invoke(api, editor, C_POSITION);
      const before: number = fake.requests.length;
      await invoke(api, editor, C_POSITION);
      assert.equal(fake.requests.length, before, 'cached again');
      const dPath = vscode.Uri.joinPath(root(), 'src/d.ts');
      const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(dPath));
      await vscode.workspace.fs.writeFile(
        dPath,
        new TextEncoder().encode(original.replace('b: number)', 'b: number, c = 0)')),
      );
      try {
        await invoke(api, editor, C_POSITION);
        assert.equal(fake.requests.length, before + 1);
        assert.ok(texts(fake.requests[fake.requests.length - 1]!).includes('c = 0'));
      } finally {
        await vscode.workspace.fs.writeFile(dPath, new TextEncoder().encode(original));
      }
    });

    it('(i) a disk edit of a symlink target with a non-source extension makes the same position ask again', async () => {
      const editor = await open('src/e.ts');
      const position = new vscode.Position(2, 17);
      await invoke(api, editor, position);
      assert.deepEqual(fake.requests[0]!.snippets, [
        { path: 'src/shared.ts', text: 'export function shared(n: number): number;' },
      ]);
      await invoke(api, editor, position);
      assert.equal(fake.requests.length, 1);
      const target = vscode.Uri.joinPath(root(), 'data/shared.source');
      const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
      await vscode.workspace.fs.writeFile(
        target,
        new TextEncoder().encode(original.replace('n: number)', 'n: number, m: number)')),
      );
      try {
        await invoke(api, editor, position);
        assert.equal(fake.requests.length, 2);
      } finally {
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(original));
      }
    });

    it('(k) a newer call answered from the cache stops an older request that is still gathering (CTX-I006)', async () => {
      const e = await open('src/e.ts');
      const ePosition = new vscode.Position(2, 17);
      await invoke(api, e, ePosition);
      assert.equal(fake.requests.length, 1);
      // Each file-system operation takes 200 ms: b.ts (no imports) gathers in two, so without the
      // takeover it would send before the newer call's check (two more) ends.
      api.setImportTiming({ delayMs: 200, deadlineMs: 10_000, dependencyCheckMs: 10_000 });
      const b = await open('src/b.ts');
      const older = invoke(api, b, new vscode.Position(1, 2));
      await sleep(100);
      const newer = invoke(api, e, ePosition);
      assert.deepEqual(await older, []);
      assert.equal((await newer).length, 1);
      // The newer call may also ask the backend if a watcher event of an earlier test arrives late
      // (its cache hit is then not used); the older request must never be sent.
      assert.ok(
        fake.requests.every((request) => request.filePath !== 'src/b.ts'),
        'the older request never reached the backend',
      );
    });

    it('(l) a source file created while a request is pending keeps its result out of the cache (CTX-I004)', async () => {
      const slow = new (class extends FakeBackend {
        override complete(req: CompletionRequest): Promise<string> {
          this.requests.push(req);
          return new Promise((resolve) => setTimeout(() => resolve(RAW), 1500));
        }
      })();
      api.setBackendOverride(slow);
      const editor = await open('src/c.ts');
      const pending = invoke(api, editor, C_POSITION);
      await sleep(200);
      const created = vscode.Uri.joinPath(root(), 'src/created-later.ts');
      await vscode.workspace.fs.writeFile(
        created,
        new TextEncoder().encode('export const later = 1;\n'),
      );
      try {
        assert.equal((await pending).length, 1);
        await invoke(api, editor, C_POSITION);
        assert.equal(slow.requests.length, 2, 'the pending result was not cached');
      } finally {
        await vscode.workspace.fs.delete(created);
      }
    });

    it('(j) a cache hit whose check is pending yields to cancellation and to a newer call; after its deadline it asks again', async () => {
      // e.ts's dependency is read from disk (never opened), so its check waits on the file system.
      const editor = await open('src/e.ts');
      const position = new vscode.Position(2, 17);
      await invoke(api, editor, position);
      assert.equal(fake.requests.length, 1);
      assert.equal(fake.requests[0]!.snippets.length, 1);

      // Cancelled while the check is pending: nothing.
      api.setImportTiming({ delayMs: 200, dependencyCheckMs: 10_000 });
      const source = new vscode.CancellationTokenSource();
      const context = {
        triggerKind: vscode.InlineCompletionTriggerKind.Invoke,
        selectedCompletionInfo: undefined,
      } as vscode.InlineCompletionContext;
      const cancelled = api.provider.provideInlineCompletionItems(
        editor.document,
        position,
        context,
        source.token,
      );
      await sleep(50);
      source.cancel();
      assert.deepEqual(await cancelled, []);

      // A newer call while the check is pending: the older call returns nothing.
      api.setImportTiming({ delayMs: 200, deadlineMs: 50, dependencyCheckMs: 10_000 });
      const older = invoke(api, editor, position);
      await sleep(50);
      const newer = invoke(api, editor, new vscode.Position(1, 0));
      assert.deepEqual(await older, []);
      await newer;
      assert.equal(fake.requests.length, 2, 'only the newer call asked the backend');

      // The check's deadline: no hit, a normal request.
      api.setImportTiming({ delayMs: 200, deadlineMs: 50, dependencyCheckMs: 50 });
      const after = await invoke(api, editor, position);
      assert.equal(after.length, 1);
      assert.equal(fake.requests.length, 3);
    });
  });
});
