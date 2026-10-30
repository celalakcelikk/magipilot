// P5 of docs/plans/phase-2-hardening.md: the exclusion oracle and the content net inside VS Code,
// with real workspace files. The fake CLI records which markers reached its stdin (never the
// text), so each test checks that an excluded file's marker did not and a kept one did.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { TestApi } from '../../src/extension';

const FAKE = resolve(__dirname, '../../../test/fixtures/fake-cli/fake-cli.mjs');
const MODEL = 'claude-cli.fake-a';
const caseInsensitivePlatform = process.platform === 'darwin' || process.platform === 'win32';

interface FakeEntry {
  stdinMarkers?: Record<string, boolean>;
  answered?: boolean;
  version?: boolean;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('magipilot');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function model(): Promise<vscode.LanguageModelChat> {
  for (let i = 0; i < 50; i++) {
    const found = (await vscode.lm.selectChatModels({ vendor: 'magipilot' })).find(
      (m) => m.id === MODEL,
    );
    if (found) return found;
    await sleep(100);
  }
  throw new Error(`model ${MODEL} did not appear`);
}

describe('Magipilot chat exclusion: oracle and content net (real files)', () => {
  const root = (): string => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const global = vscode.ConfigurationTarget.Global;
  let api: TestApi;
  let logDir: string;
  let logFile: string;
  const created: string[] = [];

  /** Creates a workspace file (removed after the test) and returns its absolute path. */
  const file = (relative: string, text: string): string => {
    const path = join(root(), relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    created.push(path);
    return path;
  };

  /** Sends one user message and returns which markers reached the fake CLI's stdin. */
  const send = async (
    markers: string[],
    messages: vscode.LanguageModelChatMessage[],
  ): Promise<Record<string, boolean>> => {
    process.env.FAKE_CLI_STDIN_MARKERS = markers.join(',');
    api.invalidateExcludedIndex();
    const response = await (await model()).sendRequest(messages, {});
    for await (const _part of response.text) {
      /* drain */
    }
    const entries = existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as FakeEntry)
      : [];
    const entry = entries.find((e) => !e.version && e.answered);
    assert.ok(entry?.stdinMarkers, 'the fake CLI received no request');
    return entry.stdinMarkers;
  };

  before(async () => {
    const extension = vscode.extensions.getExtension<TestApi>('celalakcelikk.magipilot')!;
    api = (await extension.activate())!;
    await config().update('claude.path', FAKE, global);
    await config().update('chat.claude.models', ['fake-a'], global);
  });

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'mp-excl-it-'));
    logFile = join(logDir, 'fake.jsonl');
    process.env.FAKE_CLI_LOG = logFile;
    process.env.FAKE_CLI_MODE = 'ok';
  });

  afterEach(async () => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
    await config().update('exclude', undefined, global);
    delete process.env.FAKE_CLI_STDIN_MARKERS;
  });

  after(async () => {
    for (const key of ['claude.path', 'chat.claude.models', 'exclude']) {
      await config().update(key, undefined, global);
    }
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_MODE;
  });

  it('content net: lines of an excluded file are removed from unknown tags and history (AC3)', async () => {
    file('secrets/tool-output.txt', 'TOKEN_LINE_NET_7193=abc\nshort\n');
    // An unknown tag, a history answer, a diff line and a line-numbered line: all whole lines.
    const markers = await send(
      ['TOKEN_LINE_NET_7193', 'KEEP_NET_LINE'],
      [
        vscode.LanguageModelChatMessage.User(
          '<foo>\nTOKEN_LINE_NET_7193=abc\n</foo>\nKEEP_NET_LINE',
        ),
        vscode.LanguageModelChatMessage.Assistant('Here it is:\nTOKEN_LINE_NET_7193=abc'),
        vscode.LanguageModelChatMessage.User(
          '+TOKEN_LINE_NET_7193=abc\n 3: TOKEN_LINE_NET_7193=abc',
        ),
      ],
    );
    assert.deepEqual(markers, { TOKEN_LINE_NET_7193: false, KEEP_NET_LINE: true });
  });

  it('a prompt is filtered under the exclusions in force when it is sent (P4CTX-I003)', async () => {
    const workspace = vscode.ConfigurationTarget.Workspace;
    file('late/late-secret.txt', 'LATE_SECRET_LINE_5521=x\nshort\n');
    // Discovery on, so the request's model lookup goes through it. Codex is the fake CLI too: no
    // real CLI is asked, and no "not installed" notice is left for later tests.
    await config().update('codex.path', FAKE, global);
    await config().update('chat.discoverModels', true, workspace);
    try {
      const chosen = await model();
      process.env.FAKE_CLI_STDIN_MARKERS = 'LATE_SECRET_LINE_5521,KEEP_LATE_LINE';
      api.invalidateExcludedIndex();
      // The request finds no list and waits for discovery; the file is excluded meanwhile.
      api.forgetChatModels();
      api.setExclusionFaults({ holdModelsMs: 1_500 });
      const response = chosen.sendRequest(
        [
          vscode.LanguageModelChatMessage.User(
            '<foo>\nLATE_SECRET_LINE_5521=x\n</foo>\nKEEP_LATE_LINE',
          ),
        ],
        {},
      );
      await sleep(300);
      await config().update('exclude', ['late/**'], global);
      for await (const _part of (await response).text) {
        /* drain */
      }
      const entries = readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeEntry);
      const entry = entries.find((e) => !e.version && e.answered);
      assert.deepEqual(entry?.stdinMarkers, { LATE_SECRET_LINE_5521: false, KEEP_LATE_LINE: true });
    } finally {
      api.setExclusionFaults({});
      await config().update('chat.discoverModels', false, workspace);
      await config().update('codex.path', undefined, global);
      // Window reads started under discovery end before the test's log folder goes.
      await api.clearWindows();
      await api.clearDiscoveredModels();
    }
  });

  it('content net: a UTF-16 excluded file is indexed by its text, not as binary', async () => {
    const path = join(root(), 'secrets', 'utf16.txt');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('UTF16_SECRET_LINE_3131=1\n', 'utf16le'),
      ]),
    );
    created.push(path);
    const markers = await send(
      ['UTF16_SECRET_LINE_3131'],
      [vscode.LanguageModelChatMessage.User('a\nUTF16_SECRET_LINE_3131=1\nb')],
    );
    assert.equal(markers.UTF16_SECRET_LINE_3131, false);
  });

  it('content net: an excluded FIFO does not stall the index; other files are still read', async function () {
    if (process.platform === 'win32') this.skip();
    this.timeout(15_000);
    const fifo = join(root(), 'secrets', 'pipe');
    mkdirSync(dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    created.push(fifo);
    file('secrets/next-to-pipe.txt', 'FIFO_NEIGHBOUR_LINE_4471=1\n');
    const markers = await send(
      ['FIFO_NEIGHBOUR_LINE_4471', 'KEEP_FIFO'],
      [vscode.LanguageModelChatMessage.User('x\nFIFO_NEIGHBOUR_LINE_4471=1\nKEEP_FIFO')],
    );
    assert.deepEqual(markers, { FIFO_NEIGHBOUR_LINE_4471: false, KEEP_FIFO: true });
  });

  it("'private/' excludes its descendants, for the oracle and the index (H8c, HARD-R001)", async () => {
    await config().update('exclude', ['private/'], global);
    file('private/key.txt', 'PRIVATE_DIR_LINE_5512=1\n');
    const markers = await send(
      ['PRIVATE_DIR_LINE_5512', 'KEEP_PRIVATE'],
      [vscode.LanguageModelChatMessage.User('pasted:\nPRIVATE_DIR_LINE_5512=1\nKEEP_PRIVATE')],
    );
    assert.deepEqual(markers, { PRIVATE_DIR_LINE_5512: false, KEEP_PRIVATE: true });
  });

  it('files hidden by files.exclude are still indexed (HARD-R002)', async () => {
    const files = vscode.workspace.getConfiguration('files');
    await files.update('exclude', { '**/secrets': true }, global);
    try {
      file('secrets/hidden.txt', 'HIDDEN_FILE_LINE_8820=1\n');
      const markers = await send(
        ['HIDDEN_FILE_LINE_8820'],
        [vscode.LanguageModelChatMessage.User('x\nHIDDEN_FILE_LINE_8820=1\ny')],
      );
      assert.equal(markers.HIDDEN_FILE_LINE_8820, false);
    } finally {
      await files.update('exclude', undefined, global);
    }
  });

  it('matches case-insensitively on macOS and Windows (H8a, red-team case 00)', async function () {
    if (!caseInsensitivePlatform) this.skip();
    await config().update('exclude', ['vault/**'], global);
    const path = file('Vault/api.key', 'x\n');
    const markers = await send(
      ['CASE_SECRET_MARK', 'KEEP_CASE'],
      [
        vscode.LanguageModelChatMessage.User(
          `<attachment id="api.key">\n// filepath: ${path}\nCASE_SECRET_MARK\n</attachment>\n<prompt>KEEP_CASE</prompt>`,
        ),
      ],
    );
    assert.deepEqual(markers, { CASE_SECRET_MARK: false, KEEP_CASE: true });
  });

  it('an attachment reached through a symlink to an excluded folder is excluded (H8d, case 02)', async () => {
    file('secrets/linked.key', 'x\n');
    const link = join(root(), 'linked-config');
    symlinkSync(join(root(), 'secrets'), link);
    created.push(link);
    const markers = await send(
      ['LINK_SECRET_MARK', 'KEEP_LINK'],
      [
        vscode.LanguageModelChatMessage.User(
          `<attachment id="linked.key">\n// filepath: ${link}/linked.key\nLINK_SECRET_MARK\n</attachment>\n<prompt>KEEP_LINK</prompt>`,
        ),
      ],
    );
    assert.deepEqual(markers, { LINK_SECRET_MARK: false, KEEP_LINK: true });
  });

  it('a binary attached through a symlink with another name is removed by its id (HARD-I013)', async function () {
    if (process.platform === 'win32') this.skip();
    // secrets/key.bin is binary: the index holds only its name, key.bin.
    const key = join(root(), 'secrets', 'key.bin');
    mkdirSync(dirname(key), { recursive: true });
    writeFileSync(key, Buffer.from([0x30, 0x82, 0x00, 0x01, 0x02, 0x03]));
    created.push(key);
    const alias = join(root(), 'public', 'certificate.bin');
    mkdirSync(dirname(alias), { recursive: true });
    symlinkSync(key, alias);
    created.push(alias);
    file('public/kept.bin', 'not secret\n');
    const hexDump = (id: string, mark: string): string =>
      [
        `<attachment id="${id}" startByte=0 endByte=16 totalSize=16 truncated=true>`,
        `00000000  30 82 00 01 02 03 00 00  00 00 00 00 00 00 00 00  |${mark}|`,
        '</attachment>',
      ].join('\n');
    const markers = await send(
      ['KEPT_IDONLY_MARK', 'I013_ALIAS_MARK', 'KEEP_I013_PROMPT'],
      [
        vscode.LanguageModelChatMessage.User(
          `${hexDump('kept.bin', 'KEPT_IDONLY_MARK')}\n${hexDump('certificate.bin', 'I013_ALIAS_MARK')}\n<prompt>KEEP_I013_PROMPT</prompt>`,
        ),
      ],
    );
    assert.deepEqual(markers, {
      KEPT_IDONLY_MARK: true,
      I013_ALIAS_MARK: false,
      KEEP_I013_PROMPT: true,
    });
  });

  it("a binary alias after a namesake gets Copilot's -1 suffix and is still removed (FOLLOWUP-I001)", async function () {
    if (process.platform === 'win32') this.skip();
    const key = join(root(), 'secrets', 'key.bin');
    mkdirSync(dirname(key), { recursive: true });
    writeFileSync(key, Buffer.from([0x30, 0x82, 0x00, 0x01, 0x02, 0x03]));
    created.push(key);
    const alias = join(root(), 'public', 'certificate.bin');
    mkdirSync(dirname(alias), { recursive: true });
    symlinkSync(key, alias);
    created.push(alias);
    const namesake = file('a/certificate.bin', 'plain text\n');
    const markers = await send(
      ['KEEP_NAMESAKE_TEXT', 'REPEATED_ALIAS_MARK'],
      [
        vscode.LanguageModelChatMessage.User(
          [
            '<attachment id="certificate.bin">',
            `// filepath: ${namesake}`,
            'KEEP_NAMESAKE_TEXT',
            '</attachment>',
            '<attachment id="certificate.bin-1" startByte=0 endByte=16 totalSize=16 truncated=true>',
            '00000000  30 82 00 01 02 03 00 00  00 00 00 00 00 00 00 00  |REPEATED_ALIAS_MARK|',
            '</attachment>',
          ].join('\n'),
        ),
      ],
    );
    assert.deepEqual(markers, { KEEP_NAMESAKE_TEXT: true, REPEATED_ALIAS_MARK: false });
  });

  for (const setup of ['search.followSymlinks off', 'an ignore file hides the alias'] as const) {
    it(`a binary alias is still removed when ${setup} (FOLLOWUP-I005)`, async function () {
      if (process.platform === 'win32') this.skip();
      const search = vscode.workspace.getConfiguration('search');
      if (setup === 'search.followSymlinks off')
        await search.update('followSymlinks', false, global);
      else file('.ignore', 'public/\n');
      try {
        const key = join(root(), 'secrets', 'key.bin');
        mkdirSync(dirname(key), { recursive: true });
        writeFileSync(key, Buffer.from([0x30, 0x82, 0x00, 0x01, 0x02, 0x03]));
        created.push(key);
        const alias = join(root(), 'public', 'certificate.bin');
        mkdirSync(dirname(alias), { recursive: true });
        symlinkSync(key, alias);
        created.push(alias);
        const markers = await send(
          ['SETTINGS_ALIAS_MARK', 'KEEP_SETTINGS_PROMPT'],
          [
            vscode.LanguageModelChatMessage.User(
              [
                '<attachment id="certificate.bin" startByte=0 endByte=16 totalSize=16 truncated=true>',
                '00000000  30 82 00 01 02 03 00 00  00 00 00 00 00 00 00 00  |SETTINGS_ALIAS_MARK|',
                '</attachment>',
                '<prompt>KEEP_SETTINGS_PROMPT</prompt>',
              ].join('\n'),
            ),
          ],
        );
        assert.deepEqual(markers, { SETTINGS_ALIAS_MARK: false, KEEP_SETTINGS_PROMPT: true });
      } finally {
        await search.update('followSymlinks', undefined, global);
      }
    });
  }

  it('a Git repository inside an excluded folder does not exclude other attachments (H8e, case 04)', async () => {
    const nested = join(root(), 'secrets', 'subrepo');
    mkdirSync(nested, { recursive: true });
    created.push(nested);
    execFileSync('git', ['init', '-q'], { cwd: nested });
    const git = await vscode.extensions
      .getExtension<{
        getAPI(v: 1): { openRepository(root: vscode.Uri): Promise<unknown> };
      }>('vscode.git')!
      .activate();
    await git.getAPI(1).openRepository(vscode.Uri.file(nested));
    const markers = await send(
      ['KEEP_ATTACH_04'],
      [
        vscode.LanguageModelChatMessage.User(
          `<attachment id="a.ts">\n// filepath: ${root()}/src/a.ts\nKEEP_ATTACH_04\n</attachment>`,
        ),
      ],
    );
    assert.equal(markers.KEEP_ATTACH_04, true);
  });

  it('a diff path counts under every repository: a staged deletion in an excluded one goes (case 04)', async () => {
    const kept = join(root(), 'repo04');
    const nested = join(root(), 'secrets', 'repo04');
    for (const dir of [kept, nested]) {
      mkdirSync(join(dir, 'src'), { recursive: true });
      created.push(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
    }
    writeFileSync(join(kept, 'src', 'kept.ts'), 'x\n');
    writeFileSync(join(kept, 'src', 'gone.ts'), 'x\n');
    writeFileSync(join(nested, 'src', 'gone.ts'), 'x\n');
    const local = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];
    execFileSync('git', [...local, '-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: nested });
    execFileSync('git', [...local, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'x'], {
      cwd: nested,
    });
    execFileSync('git', ['rm', '-q', 'src/gone.ts'], { cwd: nested });
    const git = (
      await vscode.extensions
        .getExtension<{
          getAPI(v: 1): {
            openRepository(root: vscode.Uri): Promise<{ status(): Promise<void> } | null>;
          };
        }>('vscode.git')!
        .activate()
    ).getAPI(1);
    for (const dir of [kept, nested])
      await (await git.openRepository(vscode.Uri.file(dir)))?.status();
    const diff = (name: string, marker: string): string =>
      [
        '```diff',
        `diff --git a/src/${name} b/src/${name}`,
        `--- a/src/${name}`,
        `+++ b/src/${name}`,
        '@@ -1 +1 @@',
        '-x',
        `+${marker}`,
        '```',
      ].join('\n');
    const markers = await send(
      ['KEEP_DIFF_04', 'GONE_DIFF_04'],
      [
        vscode.LanguageModelChatMessage.User(
          `# CODE CHANGES:\n${diff('kept.ts', 'KEEP_DIFF_04')}\n${diff('gone.ts', 'GONE_DIFF_04')}\nNow generate a commit message.`,
        ),
      ],
    );
    // gone.ts is a staged deletion of the excluded secrets/repo04 and a file of repo04: removed,
    // although it is missing from that repository's disk (security review of ff6bdfc). kept.ts is
    // only in repo04, but a diff path counts under every root: removed too (the case 04 cost).
    assert.deepEqual(markers, { KEEP_DIFF_04: false, GONE_DIFF_04: false });
  });

  it('a slash pattern naming a folder above the workspace excludes nothing in it (HARD-I002)', async () => {
    // The workspace is a temporary folder; on macOS its realpath is under /private as well.
    const parent = basename(dirname(root()));
    await config().update('exclude', [`${parent}/**`], global);
    const path = file('src/ancestor.ts', 'export const ANCESTOR_KEPT_LINE_6262 = 1;\n');
    const markers = await send(
      ['ANCESTOR_ATTACH_6262', 'ANCESTOR_KEPT_LINE_6262'],
      [
        vscode.LanguageModelChatMessage.User(
          `<attachment id="ancestor.ts">\n// filepath: ${path}\nANCESTOR_ATTACH_6262\n</attachment>\n` +
            'pasted:\nexport const ANCESTOR_KEPT_LINE_6262 = 1;',
        ),
      ],
    );
    assert.deepEqual(markers, { ANCESTOR_ATTACH_6262: true, ANCESTOR_KEPT_LINE_6262: true });
  });

  it('discovery false positives do not crowd out an excluded file (HARD-I003)', async function () {
    // On macOS and Windows the pattern i* is searched as every file (U+0130 lowercases to i).
    if (!caseInsensitivePlatform) this.skip();
    this.timeout(60_000);
    await config().update('exclude', ['i*'], global);
    const crowd = join(root(), 'crowd');
    mkdirSync(crowd, { recursive: true });
    created.push(crowd);
    for (let n = 0; n < 1_200; n++) writeFileSync(join(crowd, `n${n}.txt`), 'x\n');
    file('crowd/zz/item-secret.txt', 'I_STAR_SECRET_LINE_7310=1\n');
    const markers = await send(
      ['I_STAR_SECRET_LINE_7310'],
      [vscode.LanguageModelChatMessage.User('a\nI_STAR_SECRET_LINE_7310=1\nb')],
    );
    assert.equal(markers.I_STAR_SECRET_LINE_7310, false);
  });

  it('discovery finds names in NFC, NFD and mixed spellings (HARD-R001)', async () => {
    await config().update('exclude', ['café/café/**'], global);
    file('café/café/key.txt', 'MIXED_NORMALISATION_LINE_1=1\n');
    const markers = await send(
      ['MIXED_NORMALISATION_LINE_1'],
      [vscode.LanguageModelChatMessage.User('a\nMIXED_NORMALISATION_LINE_1=1\nb')],
    );
    assert.equal(markers.MIXED_NORMALISATION_LINE_1, false);
  });

  it('discovery finds a name starting with U+212A for the pattern Key.txt (HARD-R001)', async () => {
    await config().update('exclude', ['Key.txt'], global);
    file('kelvin/Key.txt', 'KELVIN_SIGN_LINE_4040=1\n');
    const markers = await send(
      ['KELVIN_SIGN_LINE_4040'],
      [vscode.LanguageModelChatMessage.User('a\nKELVIN_SIGN_LINE_4040=1\nb')],
    );
    assert.equal(markers.KELVIN_SIGN_LINE_4040, false);
  });

  it('discovery finds U+0130 + .txt for the patterns i* and i?.txt (HARD-R006)', async function () {
    if (!caseInsensitivePlatform) this.skip();
    for (const pattern of ['i*', 'i?.txt']) {
      await config().update('exclude', [pattern], global);
      file('dotted/İ.txt', 'DOTTED_I_LINE_6060=1\n');
      const markers = await send(
        ['DOTTED_I_LINE_6060'],
        [vscode.LanguageModelChatMessage.User('a\nDOTTED_I_LINE_6060=1\nb')],
      );
      assert.equal(markers.DOTTED_I_LINE_6060, false, pattern);
    }
  });
});
